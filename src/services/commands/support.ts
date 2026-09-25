/**
 * 指令层的共享工具与常量。
 *
 * 从 `adminCommands.ts` 抽出（R1 拆分第一步）：这些函数/常量原先散落在巨型文件尾部，
 * 现在集中在这里，供 `src/services/commands/*` 各领域子模块与门面类 `AdminCommandService` 复用。
 * 全部是纯函数（不依赖服务实例），可以直接单测。
 */

import { ActivityStatus, PermissionLevel } from "../../core/enums.js";
import type { KeyboardModal } from "../../adapters/qqOfficial.js";
import { encodeCallback, extractPageToken, pageCallback } from "../callbackData.js";
import {
  escapeCardText,
  quoteCardLines,
  renderCard,
  type CardButton,
  type CardButtonStyle,
} from "../cardTemplate.js";
import {
  JoinDecisionMode,
  KeywordPunish,
  type JoinDecisionMode as JoinDecisionModeType,
} from "../../core/enums.js";
import { getLogger } from "../../core/logger.js";
import type { AuditLog } from "../audit.js";
import { ActivityCardService } from "../activityCards.js";
import type {
  ActivityCardInput,
  ActivityExportLike,
  ActivityStatsLike,
} from "../activityCards.js";
import { code as activityCode, formatCloseAt } from "../activityCards.js";
import { ActivityRuleError } from "../activity.js";
import type {
  Activity,
  ActivityLink,
  ActivityRegistration,
  ActivityService,
  ActivityWaitlistEntry,
} from "../activity.js";
import type { ActivityNotificationService } from "../activityNotifications.js";
import type { DisplayNameService } from "../displayNames.js";
import type { MemberRoster } from "../memberRoster.js";
import {
  DEFAULT_GROUP_ID,
  type EffectiveGroupConfig,
  type GroupConfigOverride,
  type GroupConfigStore,
} from "../groupConfig.js";
import { findHelpTopic, type HelpTopic } from "../helpTopics.js";
/** 关键词单条上限（与卡片标准一致：太长会挤爆按钮）。 */
const RULE_KEYWORD_MAX_LENGTH = 50;
import {
  buildMenu,
  buildUnknownCommandMenu,
  findMenuSection,
  resolveMenuAccess,
  type MenuContext,
} from "../menu.js";
import type { RichMessage, RichMessageSender } from "../richMessages.js";
import { buildTestMenuCard, TEST_MENU_PAGE_COUNT } from "../testMenu.js";
import type { JoinRuleEvaluator } from "../joinRules.js";
import type { GroupMessageModeRegistry } from "../groupMessageMode.js";
import type { IdentityMapService } from "../identityMap.js";
import type { JoinApprovalService } from "../joinApproval.js";
import { EXPIRY_ACTOR_ID, type JoinAuditService, type JoinRequest } from "../joinAudit.js";
import type { JoinRequestSyncService } from "../joinAuditSync.js";
import {
  CLASS_ALIAS_KIND_LABELS,
  type ClassAliasService,
} from "../classAliases.js";
import { NOTIFY_SCOPE_ALL, type NotificationService } from "../notifications.js";
import type { PermissionService } from "../permissions.js";
import { formatParseNotes, parseProfileInput } from "../profileParser.js";
import {
  normalizeYear,
  PROFILE_ENTRY_YEARS,
  UserProfileError,
  yearFromStudentId,
  type UserProfile,
  type UserProfileField,
  type UserProfileService,
} from "../userProfiles.js";


export interface CommandResult {
  ok: boolean;
  text: string;
  /** 富回复（Markdown + 按钮 + 纯文本降级）；缺省时只发 text。 */
  rich?: RichMessage | undefined;
  /**
   * §B4 群内静默：`true` 表示**不往群里发任何消息**（`gatewayRunner` 跳过 `sendReply`）。
   *
   * 只用于「群里点报名 / 群里手输 `/activity join|quit`」这类**结果只能私信**的动作；
   * 私聊路径不使用该字段（私聊里原地回复）。
   */
  silent?: boolean | undefined;
}

/**
 * 卡片标准下的指令结果（见 `docs/CARD-STANDARD.md`）：**所有指令都必须给出卡片**，
 * 因此 `rich` 在这里是必填的，回调 renderer 可以直接拿它发送。
 */
export interface CardResult {
  ok: boolean;
  text: string;
  rich: RichMessage;
  /** §B4 群内静默（与 `CommandResult.silent` 同义）。 */
  silent?: boolean | undefined;
}

/** 活动列表卡的分组标题（报名中 / 草稿 / 已结束）。 */
export function listGroupOf(activity: Activity): "报名中" | "草稿" | "已结束" {
  if (activity.status === ActivityStatus.Open) {
    return "报名中";
  }
  return activity.status === ActivityStatus.Draft ? "草稿" : "已结束";
}

export function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

/** 查看/导航类按钮（标准：点击即回包 + 重发卡片）。 */
export function viewButton(
  id: string,
  label: string,
  namespace: string,
  action: string,
  ...args: readonly (string | number)[]
): CardButton {
  return {
    id,
    label,
    callbackData: encodeCallback(namespace, action, ...args),
  };
}

/** 带回调 data 与可选 `modal` 二次确认的按钮（预览/恢复这类不可逆动作）。 */
export function viewButtonWithOptions(
  id: string,
  label: string,
  callbackData: string,
  options: { modal?: KeyboardModal } = {},
): CardButton {
  return {
    id,
    label,
    callbackData,
    ...(options.modal !== undefined ? { modal: options.modal } : {}),
  };
}

/** 规则「恢复继承」类二次确认弹窗。 */
export function confirmRuleResetModal(scope: string): KeyboardModal {
  return {
    content: `确认恢复继承？将清除「${scope}」的本群覆盖，改回继承上级规则。`,
    confirmText: "确认恢复",
    cancelText: "取消",
  };
}

/** 执行动作类按钮（标准：点击=发送指令，与手输同一条权限/审计路径）。 */
export function actionButton(
  id: string,
  label: string,
  command: string,
  options: { style?: CardButtonStyle; modal?: KeyboardModal } = {},
): CardButton {
  return {
    id,
    label,
    command,
    ...(options.style !== undefined ? { style: options.style } : {}),
    ...(options.modal !== undefined ? { modal: options.modal } : {}),
  };
}

/**
 * 把已有文本结果包成卡片：正文行沿用原文本，因此**纯文本降级与旧输出等价**，
 * 按钮只是在此之上加的可选交互。
 */
export function cardFromText(
  title: string,
  text: string,
  options: {
    rows?: readonly (readonly CardButton[])[];
    buttonHint?: string;
    footer?: readonly string[];
  } = {},
): CardResult {
  const rich = renderCard({
    title,
    lines: text.split("\n"),
    ...(options.rows ? { rows: options.rows } : {}),
    ...(options.buttonHint !== undefined
      ? { buttonHint: options.buttonHint }
      : {}),
    ...(options.footer ? { footer: options.footer } : {}),
  });
  return { ok: true, text: rich.text, rich };
}

export function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "（空）";
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把反馈文案渲染成卡片行：如果第一行是提及（`<@!...>`），保持它单独成行且不转义，
 * 其余内容作为「**结果**：…」展示。
 *
 * 纯函数（R1 拆分时从门面搬出），供 `AdminCommandService` 与各领域模块复用。
 */
export function renderNotice(notice: string | undefined): string[] {
  if (!notice) {
    return [];
  }
  const [first = "", ...rest] = notice.split("\n");
  const lines: string[] = [];
  let body = first;
  if (body.startsWith("<@!")) {
    lines.push(body);
    body = rest.shift() ?? "";
  }
  if (body.length > 0) {
    lines.push(`**结果**：${escapeCardText(body)}`);
  }
  for (const line of rest) {
    lines.push(escapeCardText(line));
  }
  return lines;
}

/** 从官方 at 段（`<@!openid>` / `<@openid>`）里取出对方 id。 */
export function parseMentionTarget(text: string): string | undefined {
  const match = /<@!?([^>\s]+)>/u.exec(text);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * `/testat all` 的 @全体候选写法。
 *
 * 真机已确认：Markdown 卡片里的 `<@!openid>` 能 @ 到人，纯文本 `content` 里的却不行；
 * 而 `@everyone` 在纯文本里无效。于是这里把所有「可能让全群收到提醒」的候选写法各发一条，
 * 由真机结果来判定到底有没有可用的一条（官方群聊能力文档没有明确支持 @所有人）。
 */
export const AT_ALL_PROBES: readonly {
  label: string;
  kind: "card" | "text";
  content: string;
}[] = [
  {
    label: "Markdown 卡片正文含 `@everyone`",
    kind: "card",
    content: "【@测试】@全体候选：@everyone 这一条是 markdown 卡片。",
  },
  {
    label: "Markdown 卡片正文含 `<@!all>`",
    kind: "card",
    content: "【@测试】@全体候选：<@!all> 这一条是 markdown 卡片。",
  },
  {
    label: "Markdown 卡片正文含 `<@!everyone>`",
    kind: "card",
    content: "【@测试】@全体候选：<@!everyone> 这一条是 markdown 卡片。",
  },
  {
    label: "Markdown 卡片正文含纯文字 `@全体成员`",
    kind: "card",
    content: "【@测试】@全体候选：@全体成员 这一条只是文字，预期不会提醒。",
  },
  {
    label: "纯文本 `content` 含 `<@!all>`",
    kind: "text",
    content: "【@测试】@全体候选（纯文本）：<@!all>",
  },
];

/** 把 markdown 卡片正文压成纯文本降级文案（按钮不可用时的兜底）。 */
export function stripMarkdownForText(markdown: string): string {
  return markdown
    .replace(/\*\*/gu, "")
    .replace(/`/gu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function bindingFailureText(): string {
  return "绑定失败：数据库写入异常，请查看服务端日志后重试。";
}

/** 规则子卡里的开关项。 */
export interface RuleToggleSpec {
  field: keyof GroupConfigOverride;
  label: string;
  panel: string;
  value: boolean;
}

/** 子卡 ID 的归一化（兼容旧按钮里的 `decision` / `keywords` / `punish` 写法）。 */
export type RulePanelId =
  | "toggle"
  | "decision"
  | "punish"
  | "keyword"
  | "roster"
  | "more";

export function normalizeRulePanel(panel: string | undefined): RulePanelId {
  switch ((panel ?? "").toLowerCase()) {
    case "keyword":
    case "keywords":
      return "keyword";
    case "roster":
    case "college":
    case "year":
      return "roster";
    case "decision":
    case "join":
      return "decision";
    case "punish":
      return "punish";
    case "more":
      return "more";
    default:
      return "toggle";
  }
}

/** 每张子卡的字段白名单：`resetPage` 只允许清这些字段，防止伪造按钮清掉别的。 */
export const RULE_PANEL_FIELDS: Record<RulePanelId, readonly (keyof GroupConfigOverride)[]> = {
  toggle: ["wordFilterEnabled", "joinAuditEnabled", "keywordRecall", "exportEnabled"],
  decision: ["joinDecision"],
  punish: ["keywordPunish", "muteDurationSeconds"],
  keyword: ["keywords"],
  roster: ["allowColleges", "denyColleges", "allowYears", "denyYears"],
  more: [
    "enabled",
    "autoApproveJoin",
    "notifyAutoApproved",
    "joinReviewOpinion",
    "warningMessage",
    "joinAnswerPattern",
  ],
};

/** 关键词子卡每页条数（每行一个关键词 + 删除按钮，受 5 行键盘上限约束）。 */
export const RULE_KEYWORD_PAGE_SIZE = 3;
/** 学院点选每页条数（一行一个学院名，留出行给模式切换与翻页）。 */
export const RULE_COLLEGE_PAGE_SIZE = 4;

/** 字段 → 按钮 / 正文里的中文名。 */
export const RULE_FIELD_LABELS: Record<keyof GroupConfigOverride, string> = {
  groupId: "",
  enabled: "机器人启用",
  joinAuditEnabled: "入群审核",
  autoApproveJoin: "自动通过",
  keywords: "关键词",
  wordFilterEnabled: "关键词过滤",
  exportEnabled: "导出功能",
  rawMessageRetentionDays: "消息保留天数",
  muteDurationSeconds: "禁言时长",
  warningMessage: "警告文案",
  keywordRecall: "命中撤回",
  keywordPunish: "命中处罚",
  joinDecision: "入群决策",
  joinRequireClass: "要求班级",
  joinRequireName: "要求姓名",
  joinAnswerPattern: "回答正则",
  joinReviewOpinion: "审核意见",
  notifyAutoApproved: "通知自动通过",
  allowColleges: "允许学院",
  denyColleges: "禁止学院",
  allowYears: "允许年级",
  denyYears: "禁止年级",
};

/** 覆盖率总览里的短名（一行要塞多个字段）。 */
export const RULE_FIELD_SHORT_LABELS: Partial<Record<keyof GroupConfigOverride, string>> = {
  enabled: "启用",
  joinAuditEnabled: "入群",
  autoApproveJoin: "自动",
  keywords: "关键词",
  wordFilterEnabled: "过滤",
  exportEnabled: "导出",
  muteDurationSeconds: "禁言",
  warningMessage: "警告",
  keywordRecall: "撤回",
  keywordPunish: "处罚",
  joinDecision: "决策",
  joinRequireClass: "班级",
  joinRequireName: "姓名",
  joinAnswerPattern: "正则",
  joinReviewOpinion: "意见",
  notifyAutoApproved: "通知",
  allowColleges: "学院白",
  denyColleges: "学院黑",
  allowYears: "年级白",
  denyYears: "年级黑",
};

export function ruleFieldLabel(field: string): string {
  return RULE_FIELD_LABELS[field as keyof GroupConfigOverride] ?? field;
}

export function ruleFieldShortLabel(field: keyof GroupConfigOverride): string {
  return RULE_FIELD_SHORT_LABELS[field] ?? ruleFieldLabel(field);
}

/** 开关按钮：标签显示**当前状态**（点击后切换）。 */
export function ruleToggleButton(
  id: string,
  label: string,
  groupId: string,
  field: string,
  enabled: boolean,
  panel: string,
): CardButton {
  const button = viewButton(
    id,
    `${label} ${enabled ? "开" : "关"}`,
    "rules",
    "toggle",
    groupId,
    field,
    enabled ? "off" : "on",
    panel,
  );
  return enabled ? { ...button, style: 4 as CardButtonStyle } : button;
}

/** 枚举按钮：`● ` 标当前值（样式 4 高亮）。 */
export function ruleChoiceButton(
  id: string,
  label: string,
  groupId: string,
  field: string,
  value: string,
  current: boolean,
  panel: string,
): CardButton {
  const button = viewButton(
    id,
    `${current ? "● " : ""}${label}`,
    "rules",
    "toggle",
    groupId,
    field,
    value,
    panel,
  );
  return current ? { ...button, style: 4 as CardButtonStyle } : button;
}

export function isRosterField(
  field: string,
): field is "allowColleges" | "denyColleges" | "allowYears" | "denyYears" {
  return (
    field === "allowColleges" ||
    field === "denyColleges" ||
    field === "allowYears" ||
    field === "denyYears"
  );
}

/**
 * 名单子卡的白/黑名单切换按钮：用 `panelPage` 打开同一子卡的另一个模式。
 *
 * 不能用 `toggle`——那是「设置某字段」的回调，`/rules set` 里没有 `rosterMode` 字段。
 */
export function rosterModeButton(
  id: string,
  label: string,
  groupId: string,
  mode: "allow" | "deny",
  current: boolean,
): CardButton {
  const button = viewButton(
    id,
    `${current ? "● " : ""}${label}`,
    "rules",
    "panelPage",
    groupId,
    "roster",
    1,
    mode,
  );
  return current ? { ...button, style: 4 as CardButtonStyle } : button;
}

/** 关键词删除按钮标签：受 10 字上限约束，过长时截断（完整值由回调参数携带）。 */
export function ruleDeleteLabel(keyword: string): string {
  const max = 8;
  const text = keyword.length > max ? `${keyword.slice(0, max)}…` : keyword;
  return `删 ${text}`;
}

export const RULE_FIELDS_HELP = [
  "  keywords 广告,刷屏 / keywords clear",  "  warning <文案> / warning clear",
  "  muteDuration <秒>",
  "  wordFilter on|off",
  "  joinAudit on|off",
  "  autoApprove on|off",
  "  export on|off",
  "  enabled on|off",
  "  keywordRecall on|off                  命中关键词是否撤回消息",
  "  keywordPunish none|mute|kick|kick_blacklist   命中关键词的处罚动作",
  "  joinDecision manual|auto_approve|approve_on_match|reject_on_match|reject_on_mismatch",
  "  joinRequireClass on|off               入群答案必须包含班级库中的班级",
  "  joinRequireName on|off                入群答案必须包含姓名",
  "  joinAnswerPattern <正则> / clear      入群答案必须匹配的额外正则",
  "  joinReviewOpinion on|off              人工审核时是否给出审核意见",
  "  notifyAutoApproved on|off             机器人自动通过/拒绝的申请是否也推送给审核员",
  "  allowColleges / denyColleges <学院列表>   学院白/黑名单（clear 清空）",
  "  allowYears / denyYears <年级列表>     年级白/黑名单（22/23/…，clear 清空）",
];

export const RULES_SET_USAGE = [
  "用法：/rules set <字段> <值>",
  "字段：",
  ...RULE_FIELDS_HELP,
  "私信中使用：/rules set <group_openid> <字段> <值>",
].join("\n");

/** `/rules add keyword` 的用法（关键词逐条增删，§C）。 */
export const RULES_ADD_USAGE = [
  "用法：/rules add keyword <词>",
  "私信：/rules add <群号|#群短码> keyword <词>",
  "全局：/rules add all keyword <词>（仅超管）",
  `关键词会 trim、去重、按字典序保存，单条不超过 ${RULE_KEYWORD_MAX_LENGTH} 字。`,
].join("\n");

export const RULES_DEL_USAGE = [
  "用法：/rules del keyword <词>",
  "私信：/rules del <群号|#群短码> keyword <词>",
  "全局：/rules del all keyword <词>（仅超管）",
].join("\n");

export const GLOBAL_RULES_SET_USAGE = [
  "用法：/rules set all <字段> <值>（仅超级管理员）",
  "字段：",
  ...RULE_FIELDS_HELP,
].join("\n");

export const GLOBAL_RULES_DENIED =
  "权限不足：全局规则仅超级管理员可以查看与修改。";

export const MAX_MUTE_DURATION_SECONDS = 30 * 24 * 60 * 60;
export const MAX_AUDIT_LIMIT = 50;
export const DEFAULT_AUDIT_LIMIT = 10;
export const GLOBAL_TARGETS = new Set(["all", "global", "default", "全局", "默认"]);
/** `/perm grant gsuper` 的别名：本群超级管理员。 */
export const GROUP_SUPER_ROLES = new Set([
  "gsuper",
  "groupsuper",
  "群超管",
  "本群超管",
  "群超级管理员",
]);
export const PERM_USAGE = [
  "用法：",
  "/perm list [#群短码|群号]",
  "/perm grant|revoke super <userId|QQ号> - 全局超级管理员",
  "/perm grant|revoke gsuper [#群短码|群号] <userId|QQ号> - 本群超级管理员",
  "/perm grant|revoke admin [#群短码|群号] <userId|QQ号> - 群管理员",
  "/perm grant|revoke mod [#群短码|群号] <userId|QQ号> - 审核员",
].join("\n");
export const TOGGLE_ON = new Set(["on", "true", "1", "yes", "y", "开", "启用", "是"]);
export const TOGGLE_OFF = new Set(["off", "false", "0", "no", "n", "关", "关闭", "否"]);
export const CLEAR_WORDS = new Set(["clear", "清空", "默认", "reset"]);
/** `/notify all on` 里的「全部群」写法。 */
export const NOTIFY_ALL_WORDS = new Set([
  "all",
  "global",
  "全部",
  "全局",
  "所有",
  "默认",
]);
export const NOTIFY_USAGE = [
  "用法：",
  "  /notify                              查看当前推送订阅",
  "  /notify on|off                       群内=本群；私信=你担任群管理员的全部群",
  "  /notify all on|off                   全部群（群内/私信均可）",
  "  /notify <群号|group_openid|#群短码> on|off    指定群",
  "  /notify test                         给自己发一张推送测试卡片",
].join("\n");
export const NOTIFY_PERMISSION_DENIED =
  "权限不足：入群审批需要群管理员或以上权限（推送与快捷按钮只发给能审批的人）。";

export function isToggleValue(value: string | undefined): value is string {
  const normalized = normalize(value);
  return TOGGLE_ON.has(normalized) || TOGGLE_OFF.has(normalized);
}

export function isToggleOn(value: string): boolean {
  return TOGGLE_ON.has(normalize(value));
}

export function isAllScope(value: string | undefined): boolean {
  return NOTIFY_ALL_WORDS.has(normalize(value));
}

/** `/profile set` 的字段别名。 */
export const PROFILE_FIELD_ALIASES: Record<string, UserProfileField> = {
  name: "name",
  姓名: "name",
  名字: "name",
  id: "studentId",
  studentid: "studentId",
  学号: "studentId",
  class: "className",
  classname: "className",
  班级: "className",
  college: "college",
  学院: "college",
  year: "year",
  年级: "year",
};

/** 回执里显示的中文字段名。 */
export const PROFILE_FIELD_LABELS: Record<UserProfileField, string> = {
  name: "姓名",
  studentId: "学号",
  className: "班级",
  college: "学院",
  year: "年级",
};

export const ALIAS_USAGE = [
  "用法（仅全局超级管理员）：",
  "  /alias                            查看别名表",
  "  /alias set <别名> <规范名>         新增/覆盖（目标必须是班级库里的班级/学院/专业）",
  "  /alias del <别名>                 删除",
  "",
  "示例：",
  "  /alias set 环工2214 环境类2214",
  "  /alias set 化生学院 化学与生命科学学院",
  "说明：目标类型由规范名自动判定；别名会用于 /profile set 智能识别与入群审核的班级匹配。",
].join("\n");

export const WHOIS_MENTION_HINT = [
  "无法从 @昵称 反查用户：请在群里**直接 @ 对方**（官方消息会带上对方 id），",
  "或改用 QQ号 / userId / #用户短码。",
].join("\n");

export const WHOIS_USAGE = [
  "用法（仅超级管理员）：",
  "  /whois                                    当前上下文（群聊=本群，私聊=你自己）",
  "  /whois <QQ号|userId|#短码>                 查用户或群的映射",
  "  /whois profile <QQ号|userId|#短码>         查个人资料（姓名/学号/班级/学院/年级）",
].join("\n");

export const PROFILE_USAGE = [
  "用法：",
  "  /profile                                 查看个人资料",
  "  /profile set <班级> <姓名> <11位学号>      智能识别，顺序随意、分隔符随意",
  "  /profile set name <姓名>                  姓名",
  "  /profile set id <11位学号>                学号（前两位决定年级：22-26）",
  "  /profile set class <班级>                 班级（必须在班级库里，自动带出学院）",
  "  /profile set college <学院>               学院（可手动覆盖）",
  "  /profile set year <年级>                  年级（可手动覆盖，只写两位，如 22）",
  "  /profile set <字段> clear                 清除单个字段",
  "  /profile clear                            清空整份资料",
  "",
  "智能识别支持：空格 / - / + / 分隔，如 材化2211 张三 22123456789",
  "或 张三-材化2211-22123456789；也可用 班级=材化2211 明确指定。",
  "年级只接受两位（22），四位年份（2022）会被拒绝。",
  "识别不确定时不会写入，会列出识别结果并提示改用 字段=值。",
].join("\n");

export const ACTIVITY_USAGE = [
  "用法：",
  "  /activity                                查看本群活动列表",
  "  /activity list <群号|#群短码>             查看指定群活动",
  "  /activity create <标题>                   创建活动（群管理员+；私信需先写群号）",
  "  /activity set <#活动短码> <字段> <值>       配置（标题/简介/名额/群号/链接/学院/年级限制）",
  "  /activity open <#活动短码>                 开放报名并把卡片发到所有绑定群",
  "  /activity close|/activity cancel <#活动短码>  关闭 / 取消活动",
  "  /activity bind <#活动短码> <群号|#群短码>   绑定发布/广播的目标群（可多个）",
  "  /activity unbind <#活动短码> <群号|#群短码> 解绑目标群",
  "  /activity join <#活动短码> [备注]           报名（需 /profile 完整；群里结果只私信）",
  "  /activity quit <#活动短码>                 取消报名（群里结果只私信）",
  "  /activity info <#活动短码>                 活动详情",
  "  /activity signups <#活动短码>              报名名单（群管理员/发布者）",
].join("\n");

/** 改到这些字段时，给已报名 + 候补私信一次变更通知（去重 + 每日封顶）。 */
export const ACTIVITY_NOTIFY_FIELDS = new Set([
  "title",
  "标题",
  "desc",
  "description",
  "描述",
  "capacity",
  "名额",
  "group",
  "群号",
  "link",
  "链接",
  "links",
  "链接列表",
  "closeat",
  "截止",
  "waitlistpromotion",
  "递补",
  "allowcolleges",
  "允许学院",
  "denycolleges",
  "禁止学院",
  "不允许学院",
  "allowyears",
  "允许年级",
  "denyyears",
  "禁止年级",
  "不允许年级",
]);

export const ACTIVITY_SET_USAGE = [
  "用法：/activity set <#活动短码> <字段> <值>",
  "字段（大小写不敏感，clear 清空）：",
  "  title <标题>                              活动标题",
  "  desc <简介>                               活动简介",
  "  capacity <人数>                            名额上限",
  "  group <群号>                               展示用活动群号",
  "  link <url> / link <说明=url>               追加一个链接（可多次）",
  "  links clear                               清空链接",
  "  allowColleges / denyColleges <学院列表>     学院白名单 / 黑名单",
  "  allowYears / denyYears <年级列表>           年级白名单 / 黑名单（22/23/…）",
  "",
  "绑定群（发布与满员广播的目标群，可多个）：",
  "  /activity bind <#活动短码> <群号|#群短码>     绑定",
  "  /activity unbind <#活动短码> <群号|#群短码>   解绑",
].join("\n");

/**
 * 群展示名列表：`群号 / 短码`，空列表返回空串（调用方自己给「（无）」）。
 *
 * 回执里列出各群发送结果时用它，避免直接暴露 openid。
 */
export function formatGroupList(
  groupIds: readonly string[],
  label: (groupId: string) => string,
): string {
  return groupIds.map((groupId) => label(groupId)).join("、");
}

/** 逗号/顿号/空格分隔的列表。 */
export function parseList(value: string): string[] {
  return value
    .split(/[,，、\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 年级列表：22 / 2022 都接受，统一存 2 位。 */
export function parseYearList(value: string): string[] {
  // normalizeYear 现在返回两位（22），并拒绝四位完整年份
  return parseList(value).map((item) => normalizeYear(item));
}

/** `<说明=url>` 或纯 url。 */
export function parseLink(value: string): ActivityLink {
  const index = value.indexOf("=");
  if (index > 0 && !value.slice(0, index).includes(":")) {
    const label = value.slice(0, index).trim();
    const url = value.slice(index + 1).trim();
    if (label.length > 0 && /^https?:\/\//u.test(url)) {
      return { label, url };
    }
  }
  if (!/^https?:\/\//u.test(value)) {
    throw new Error("链接必须以 http:// 或 https:// 开头");
  }
  return { label: "活动链接", url: value };
}

export function parseLinks(value: string): ActivityLink[] {
  return parseList(value).map((item) => parseLink(item));
}

/**
 * 报名截止时间：接受 `MM-DD HH:mm`（默认当年）或 `YYYY-MM-DD HH:mm`。
 *
 * 只做最小解析，不做「已过去」校验：管理员可能就是想立刻截止（懒校验会在报名时拒绝）。
 */
export function parseCloseAt(value: string): Date {
  const match =
    /^(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})$/u.exec(
      value.trim(),
    );
  if (!match) {
    throw new Error("截止时间格式：MM-DD HH:mm（当天日期）或 YYYY-MM-DD HH:mm");
  }
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute] = match;
  const now = new Date();
  const year = rawYear ? Number.parseInt(rawYear, 10) : now.getFullYear();
  const date = new Date(
    year,
    Number.parseInt(rawMonth!, 10) - 1,
    Number.parseInt(rawDay!, 10),
    Number.parseInt(rawHour!, 10),
    Number.parseInt(rawMinute!, 10),
  );
  if (Number.isNaN(date.getTime())) {
    throw new Error("截止时间不合法");
  }
  return date;
}

/** 名单卡页码：`/activity signups #码 [+页码] [full]`。 */
export function parseSignupPage(parts: readonly string[]): number {
  for (const part of parts.slice(3)) {
    const token = /^\+(\d+)$/u.exec(part);
    if (token) {
      return Number.parseInt(token[1]!, 10) || 1;
    }
  }
  const bare = parts[3];
  if (bare && /^\d+$/u.test(bare)) {
    return Number.parseInt(bare, 10) || 1;
  }
  return 1;
}

export function parsePositiveInt(field: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} 需要正整数`);
  }
  return parsed;
}

/** `/rules all`、`/rules 全局`、`/rules set default ...` 都指向全局规则。 */
export function isGlobalTarget(value: string | undefined): boolean {
  return GLOBAL_TARGETS.has(normalize(value));
}

export function formatEffectiveConfig(
  config: EffectiveGroupConfig,
  header: string,
): string {
  const keywords =
    config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）";
  return [
    header,
    `启用：${config.enabled}`,
    `关键词过滤：${config.wordFilterEnabled}`,
    `关键词：${keywords}`,
    `关键词撤回：${config.keywordRecall}`,
    `命中处罚：${config.keywordPunish}`,
    `入群审核：${config.joinAuditEnabled}`,
    `入群决策：${config.joinDecision}`,
    `入群要求：班级 ${config.joinRequireClass} · 姓名 ${config.joinRequireName}${
      config.joinAnswerPattern ? ` · 正则 /${config.joinAnswerPattern}/` : ""
    }`,
    `审核意见：${config.joinReviewOpinion}`,
    `自动通过：${config.autoApproveJoin}`,
    `自动处理也通知：${config.notifyAutoApproved}`,
    `导出功能：${config.exportEnabled}`,
    `警告文案：${config.warningMessage}`,
    `禁言时长：${config.muteDurationSeconds} 秒`,
    `允许学院：${config.allowColleges.length > 0 ? config.allowColleges.join("、") : "（不限）"}`,
    `禁止学院：${config.denyColleges.length > 0 ? config.denyColleges.join("、") : "（无）"}`,
    `允许年级：${config.allowYears.length > 0 ? config.allowYears.join("、") : "（不限）"}`,
    `禁止年级：${config.denyYears.length > 0 ? config.denyYears.join("、") : "（无）"}`,
  ].join("\n");
}

export function parseRuleSetting(
  groupId: string,
  field: string,
  value: string,
  configStore: GroupConfigStore,
): GroupConfigOverride {
  const cleared = CLEAR_WORDS.has(value.toLowerCase());
  const key = normalize(field);
  if (key === "keywords" || key === "keyword" || key === "关键词") {
    return {
      groupId,
      keywords: cleared
        ? []
        : value
            .split(/[,，、\s]+/u)
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
    };
  }
  switch (key) {
    case "warning":
    case "warningmessage":
    case "警告":
    case "警告文案":
      return {
        groupId,
        warningMessage: cleared
          ? groupId === DEFAULT_GROUP_ID
            ? configStore.builtinDefault.warningMessage
            : configStore.default.warningMessage
          : value,
      };
    case "muteduration":
    case "mutedurationseconds":
    case "mute":
    case "禁言时长":
      return { groupId, muteDurationSeconds: parseDuration(value) };
    case "autoapprove":
    case "autoapprovejoin":
    case "自动通过":
      return { groupId, autoApproveJoin: parseToggle(field, value) };
    case "joinaudit":
    case "joinauditenabled":
    case "入群审核":
      return { groupId, joinAuditEnabled: parseToggle(field, value) };
    case "wordfilter":
    case "wordfilterenabled":
    case "关键词过滤":
      return { groupId, wordFilterEnabled: parseToggle(field, value) };
    case "export":
    case "exportenabled":
    case "导出":
      return { groupId, exportEnabled: parseToggle(field, value) };
    case "enabled":
    case "启用":
      return { groupId, enabled: parseToggle(field, value) };
    case "keywordrecall":
    case "recall":
    case "撤回":
      return { groupId, keywordRecall: parseToggle(field, value) };
    case "keywordpunish":
    case "punish":
    case "处罚":
      return { groupId, keywordPunish: parseKeywordPunish(value) };
    case "joindecision":
    case "入群决策":
      return { groupId, joinDecision: parseJoinDecision(value) };
    case "joinrequireclass":
    case "requireclass":
    case "要求班级":
      return { groupId, joinRequireClass: parseToggle(field, value) };
    case "joinrequirename":
    case "requirename":
    case "要求姓名":
      return { groupId, joinRequireName: parseToggle(field, value) };
    case "joinanswerpattern":
    case "answerpattern":
    case "入群正则":
      return {
        groupId,
        joinAnswerPattern: cleared ? "" : requireValidRegex(value),
      };
    case "joinreviewopinion":
    case "审核意见":
      return { groupId, joinReviewOpinion: parseToggle(field, value) };
    case "notifyautoapproved":
    case "autonotify":
    case "通知自动通过":
    case "通知自动处理":
      return { groupId, notifyAutoApproved: parseToggle(field, value) };
    case "allowcolleges":
    case "允许学院":
    case "学院白名单":
      return { groupId, allowColleges: cleared ? [] : parseListItems(value) };
    case "denycolleges":
    case "禁止学院":
    case "不允许学院":
    case "学院黑名单":
      return { groupId, denyColleges: cleared ? [] : parseListItems(value) };
    case "allowyears":
    case "允许年级":
    case "年级白名单":
      return { groupId, allowYears: cleared ? [] : parseListItems(value) };
    case "denyyears":
    case "禁止年级":
    case "不允许年级":
    case "年级黑名单":
      return { groupId, denyYears: cleared ? [] : parseListItems(value) };
    default:
      throw new Error(`未知字段：${field}`);
  }
}

/** 逗号 / 顿号 / 空格分隔的字符串列表（学院、年级等）。 */
export function parseListItems(value: string): string[] {
  return value
    .split(/[,，、\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseKeywordPunish(value: string): KeywordPunish {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, KeywordPunish> = {
    none: KeywordPunish.None,
    off: KeywordPunish.None,
    "无": KeywordPunish.None,
    "不处罚": KeywordPunish.None,
    mute: KeywordPunish.Mute,
    "禁言": KeywordPunish.Mute,
    kick: KeywordPunish.Kick,
    "踢出": KeywordPunish.Kick,
    "移出": KeywordPunish.Kick,
    kick_blacklist: KeywordPunish.KickBlacklist,
    blacklist: KeywordPunish.KickBlacklist,
    "踢出并拉黑": KeywordPunish.KickBlacklist,
    "拉黑": KeywordPunish.KickBlacklist,
  };
  const parsed = aliases[normalized];
  if (!parsed) {
    throw new Error("处罚动作需要 none / mute / kick / kick_blacklist");
  }
  return parsed;
}

export function parseJoinDecision(value: string): JoinDecisionModeType {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, JoinDecisionMode> = {
    manual: JoinDecisionMode.Manual,
    "人工": JoinDecisionMode.Manual,
    "人工审核": JoinDecisionMode.Manual,
    auto: JoinDecisionMode.AutoApprove,
    auto_approve: JoinDecisionMode.AutoApprove,
    "自动通过": JoinDecisionMode.AutoApprove,
    approve_on_match: JoinDecisionMode.ApproveOnMatch,
    "命中通过": JoinDecisionMode.ApproveOnMatch,
    reject_on_match: JoinDecisionMode.RejectOnMatch,
    "命中拒绝": JoinDecisionMode.RejectOnMatch,
    reject_on_mismatch: JoinDecisionMode.RejectOnMismatch,
    "未命中拒绝": JoinDecisionMode.RejectOnMismatch,
  };
  const parsed = aliases[normalized];
  if (!parsed) {
    throw new Error(
      "入群决策需要 manual / auto_approve / approve_on_match / reject_on_match / reject_on_mismatch",
    );
  }
  return parsed;
}

export function requireValidRegex(value: string): string {
  try {
    new RegExp(value, "u");
    return value;
  } catch (error) {
    throw new Error(
      `入群正则不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseToggle(field: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (TOGGLE_ON.has(normalized)) {
    return true;
  }
  if (TOGGLE_OFF.has(normalized)) {
    return false;
  }
  throw new Error(`${field} 需要 on 或 off`);
}

export function parseDuration(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("禁言时长需要非负整数（秒）");
  }
  return Math.min(parsed, MAX_MUTE_DURATION_SECONDS);
}

export function clampLimit(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUDIT_LIMIT;
  }
  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

export function formatTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}