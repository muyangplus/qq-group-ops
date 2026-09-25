import type { CardResult, CommandResult } from "./commands/support.js";
import { aliasCard } from "./commands/aliasCommands.js";
import type { AdminCommandContext } from "./commands/context.js";
import { ActivityStatus, PermissionLevel } from "../core/enums.js";
import type { KeyboardModal } from "../adapters/qqOfficial.js";
import { encodeCallback, extractPageToken, pageCallback } from "./callbackData.js";
import {
  escapeCardText,
  quoteCardLines,
  renderCard,
  type CardButton,
  type CardButtonStyle,
} from "./cardTemplate.js";
import {
  JoinDecisionMode,
  KeywordPunish,
  type JoinDecisionMode as JoinDecisionModeType,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AuditLog } from "./audit.js";
import { ActivityCardService } from "./activityCards.js";
import type {
  ActivityCardInput,
  ActivityExportLike,
  ActivityStatsLike,
} from "./activityCards.js";
import { code as activityCode, formatCloseAt } from "./activityCards.js";
import { ActivityRuleError } from "./activity.js";
import type {
  Activity,
  ActivityLink,
  ActivityRegistration,
  ActivityService,
  ActivityWaitlistEntry,
} from "./activity.js";
import type { ActivityNotificationService } from "./activityNotifications.js";
import type { DisplayNameService } from "./displayNames.js";
import type { MemberRoster } from "./memberRoster.js";
import {
  DEFAULT_GROUP_ID,
  type EffectiveGroupConfig,
  type GroupConfigOverride,
  type GroupConfigStore,
} from "./groupConfig.js";
import { findHelpTopic, type HelpTopic } from "./helpTopics.js";
/** 关键词单条上限（与卡片标准一致：太长会挤爆按钮）。 */
const RULE_KEYWORD_MAX_LENGTH = 50;
import {
  buildMenu,
  buildUnknownCommandMenu,
  findMenuSection,
  resolveMenuAccess,
  type MenuContext,
} from "./menu.js";
import type { RichMessage, RichMessageSender } from "./richMessages.js";
import { buildTestMenuCard, TEST_MENU_PAGE_COUNT } from "./testMenu.js";
import type { JoinRuleEvaluator } from "./joinRules.js";
import type { GroupMessageModeRegistry } from "./groupMessageMode.js";
import type { IdentityMapService } from "./identityMap.js";
import type { JoinApprovalService } from "./joinApproval.js";
import { EXPIRY_ACTOR_ID, type JoinAuditService, type JoinRequest } from "./joinAudit.js";
import type { JoinRequestSyncService } from "./joinAuditSync.js";
import {
  CLASS_ALIAS_KIND_LABELS,
  type ClassAliasService,
} from "./classAliases.js";
import { NOTIFY_SCOPE_ALL, type NotificationService } from "./notifications.js";
import type { PermissionService } from "./permissions.js";
import { formatParseNotes, parseProfileInput } from "./profileParser.js";
import {
  normalizeYear,
  PROFILE_ENTRY_YEARS,
  UserProfileError,
  yearFromStudentId,
  type UserProfile,
  type UserProfileField,
  type UserProfileService,
} from "./userProfiles.js";

import {
  actionButton,
  ACTIVITY_NOTIFY_FIELDS,
  ACTIVITY_SET_USAGE,
  ACTIVITY_USAGE,
  ALIAS_USAGE,
  AT_ALL_PROBES,
  bindingFailureText,
  cardFromText,
  clampLimit,
  CLEAR_WORDS,
  confirmRuleResetModal,
  DEFAULT_AUDIT_LIMIT,
  formatEffectiveConfig,
  formatError,
  formatGroupList,
  formatList,
  formatTime,
  GLOBAL_RULES_DENIED,
  GLOBAL_RULES_SET_USAGE,
  GLOBAL_TARGETS,
  GROUP_SUPER_ROLES,
  indentBlock,
  isAllScope,
  isGlobalTarget,
  isRosterField,
  isToggleOn,
  isToggleValue,
  listGroupOf,
  MAX_AUDIT_LIMIT,
  MAX_MUTE_DURATION_SECONDS,
  normalize,
  normalizeRulePanel,
  NOTIFY_ALL_WORDS,
  NOTIFY_PERMISSION_DENIED,
  NOTIFY_USAGE,
  parseCloseAt,
  parseDuration,
  parseJoinDecision,
  parseKeywordPunish,
  parseLink,
  parseLinks,
  parseList,
  parseListItems,
  parseMentionTarget,
  parsePositiveInt,
  parseRuleSetting,
  parseSignupPage,
  parseToggle,
  parseYearList,
  PERM_USAGE,
  PROFILE_FIELD_ALIASES,
  PROFILE_FIELD_LABELS,
  PROFILE_USAGE,
  requireValidRegex,
  rosterModeButton,
  RULE_COLLEGE_PAGE_SIZE,
  RULE_FIELD_LABELS,
  RULE_FIELD_SHORT_LABELS,
  RULE_FIELDS_HELP,
  RULE_KEYWORD_PAGE_SIZE,
  RULE_PANEL_FIELDS,
  ruleChoiceButton,
  ruleDeleteLabel,
  ruleFieldLabel,
  ruleFieldShortLabel,
  RulePanelId,
  RULES_ADD_USAGE,
  RULES_DEL_USAGE,
  RULES_SET_USAGE,
  ruleToggleButton,
  RuleToggleSpec,
  stripMarkdownForText,
  TOGGLE_OFF,
  TOGGLE_ON,
  viewButton,
  viewButtonWithOptions,
  WHOIS_MENTION_HINT,
  WHOIS_USAGE,
} from "./commands/support.js";
const log = getLogger("admin-commands");

/** 通用卡片标题（未单独定制卡片的指令用）。 */
const COMMAND_CARD_TITLES: Record<string, string> = {
  myperm: "我的权限",
  whois: "映射查询",
  bind: "绑定",
  profile: "个人资料",
  activity: "活动",
  perm: "权限配置",
  notify: "入群申请推送",
  audit: "审计记录",
  sync: "同步官方申请",
  approve: "审批结果",
  reject: "审批结果",
  test: "自检结果",
  rules: "群规则",
  pending: "待审批入群申请",
  status: "运行状态",
  help: "指令帮助",
  menu: "系统菜单",
  testmenu: "测试菜单",
};



/**
 * §B4 落地选项：报名 / 取消报名的结果**只私信**。
 *
 * - `dmOnly: true` 表示「结果私信给本人，群里不发结果」；
 * - `dmSilent: true` 表示命令路径（`silent: true`，跳过群回复）；
 *   回调路径为 `false`（命中静默时渲染器不发言）；
 * - 群内与私聊都走同一套 handler，私聊传 `dmOnly: false` 原地回复。
 */
interface ActivityDmOptions {
  dmOnly: boolean;
  dmSilent: boolean;
}

export interface AdminCommandServiceOptions {
  permissions: PermissionService;
  joinAudit: JoinAuditService;
  configStore: GroupConfigStore;
  joinApproval: JoinApprovalService;
  joinSync: JoinRequestSyncService;
  auditLog: AuditLog;
  /** 入群规则评估器（用于在 /pending 里给出审核意见）。 */
  joinRules?: JoinRuleEvaluator | undefined;
  groupMessageMode?: GroupMessageModeRegistry | undefined;
  identityMap?: IdentityMapService | undefined;
  /** 展示名解析（群号/QQ号/短码）；缺省时回退到绑定号或内部 id（测试用）。 */
  display?: DisplayNameService | undefined;
  /** 个人资料（班级/学院/姓名/学号）。 */
  userProfiles?: UserProfileService | undefined;
  /** 班级/学院/专业别名表（全局超管维护）。 */
  classAliases?: ClassAliasService | undefined;
  /** 活动发布/报名/管理。 */
  activity?: ActivityService | undefined;
  /** 活动卡片渲染（memberCard / configCard / manageCard / signupsCard / rulesCard）。 */
  activityCards?: ActivityCardService | undefined;
  /** 活动通知（按群订阅 + 去重封顶的私信推送）。 */
  activityNotifications?: ActivityNotificationService | undefined;
  /** 班级库（活动学院/年级限制按钮）；缺省时对应按钮不生成。 */
  activityRoster?: MemberRoster | undefined;
  /** §B3 统计图片服务；未装配时活动管理卡不生成「统计图片」按钮。 */
  activityStats?: ActivityStatsLike | undefined;
  /** §B3 CSV 导出服务；未装配时名单卡不生成「导出 CSV」按钮。 */
  activityExport?: ActivityExportLike | undefined;
  /** 入群申请推送（`/notify`）。 */
  notifications?: NotificationService | undefined;
  /** 富消息发送器（`/testat` 与活动发布需要「纯文本 + 卡片」两条通道）。 */
  richMessages?: RichMessageSender | undefined;
  /** 活动卡片发送器；缺省时复用 `richMessages`，再缺省用通知服务的发送器。 */
  cardSender?: RichMessageSender | undefined;
}

export class AdminCommandService {
  private readonly permissions: PermissionService;
  private readonly joinAudit: JoinAuditService;
  private readonly configStore: GroupConfigStore;
  private readonly joinApproval: JoinApprovalService;
  private readonly joinSync: JoinRequestSyncService;
  private readonly auditLog: AuditLog;
  private readonly joinRules: JoinRuleEvaluator | undefined;
  private readonly groupMessageMode: GroupMessageModeRegistry | undefined;
  private readonly identityMap: IdentityMapService | undefined;
  private readonly display: DisplayNameService | undefined;
  private readonly userProfiles: UserProfileService | undefined;
  private readonly classAliases: ClassAliasService | undefined;
  private readonly activity: ActivityService | undefined;
  private readonly activityCards: ActivityCardService | undefined;
  private readonly activityNotifications: ActivityNotificationService | undefined;
  private readonly activityStats: ActivityStatsLike | undefined;
  private readonly activityExport: ActivityExportLike | undefined;
  private readonly notifications: NotificationService | undefined;
  private readonly richMessages: RichMessageSender | undefined;
  private readonly explicitCardSender: RichMessageSender | undefined;
  /** 班级库（活动学院/年级按钮）；runtime.load() 里拿到后注入。 */
  private activityRoster: MemberRoster | undefined;
  /** §B3 统计图片服务；装配后管理卡才会出现「统计图片」按钮。 */
  private activityStatsService: ActivityStatsLike | undefined;
  /** §B3 CSV 导出服务；装配后名单卡才会出现「导出 CSV」按钮。 */
  private activityExportService: ActivityExportLike | undefined;

  public constructor(options: AdminCommandServiceOptions) {
    this.permissions = options.permissions;
    this.joinAudit = options.joinAudit;
    this.configStore = options.configStore;
    this.joinApproval = options.joinApproval;
    this.joinSync = options.joinSync;
    this.auditLog = options.auditLog;
    this.joinRules = options.joinRules;
    this.groupMessageMode = options.groupMessageMode;
    this.identityMap = options.identityMap;
    this.display = options.display;
    this.userProfiles = options.userProfiles;
    this.classAliases = options.classAliases;
    this.activity = options.activity;
    this.activityCards = options.activityCards;
    this.activityNotifications = options.activityNotifications;
    this.activityRoster = options.activityRoster;
    this.activityStatsService = options.activityStats;
    this.activityExportService = options.activityExport;
    this.notifications = options.notifications;
    this.richMessages = options.richMessages;
    this.explicitCardSender = options.cardSender;
  }

  /** 班级库在 `runtime.load()` 里才加载完成，因此构造后再注入（与 UserProfileService 同套路）。 */
  public setActivityRoster(roster: MemberRoster | undefined): void {
    this.activityRoster = roster;
  }

  /**
   * §B3 后接线：装配统计图片 / CSV 导出服务。
   *
   * 未装配时活动管理卡不出「统计图片」按钮、名单卡不出「导出 CSV」按钮（条件渲染），
   * 回调被直接调用时也只会得到友好提示，不会抛错。
   *
   * 注意要**同时**同步给已装配的 `ActivityCardService`：它自己按能力做条件渲染，
   * 只改这里的字段会让「按钮入口」和「回调实现」不一致（有实现没入口）。
   */
  public setActivityExtras(extras: {
    stats?: ActivityStatsLike | undefined;
    exportService?: ActivityExportLike | undefined;
  }): void {
    if (extras.stats !== undefined) {
      this.activityStatsService = extras.stats;
    }
    if (extras.exportService !== undefined) {
      this.activityExportService = extras.exportService;
    }
    this.activityCards?.setActivityExtras(extras);
  }

  public async handle(
    groupId: string | undefined,
    userId: string,
    text: string,
  ): Promise<CommandResult> {
    const parts = text.trim().split(/\s+/u).filter((part) => part.length > 0);
    if (parts.length === 0) {
      // 空内容（群里 @机器人 不带参数）等价于打开主菜单
      return this.handleMenu(groupId, userId, ["menu"]);
    }
    const command = parts[0]!.replace(/^\//u, "").toLowerCase();
    log.debug("command", { groupId, userId, command });

    const bindingExempt = new Set(["help", "帮助", "bind", "绑定", "menu", "菜单"]);
    // 个人资料与群绑定无关：只需要绑定自己的 QQ 号
    const groupBindingExempt = new Set([...bindingExempt, "profile", "资料"]);
    if (
      !bindingExempt.has(command) &&
      this.identityMap &&
      !this.identityMap.getQq(userId)
    ) {
      log.warn("binding required", { groupId, userId, command });
      return {
        ok: false,
        text: "请先绑定 QQ 号：/bind qq <QQ号>",
      };
    }

    if (
      groupId &&
      !groupBindingExempt.has(command) &&
      this.identityMap &&
      !this.identityMap.getGroupNumber(groupId)
    ) {
      log.warn("group binding required", { groupId, userId, command });
      return {
        ok: false,
        text: "请先绑定本群：/bind group <群号>",
      };
    }

    const result = await this.dispatchCommand(command, groupId, userId, parts);
    return this.ensureCard(command, result, groupId, userId);
  }

  /**
   * 卡片标准兜底：**任何指令输出都必须是卡片**。
   *
   * 已经单独实现卡片的指令（help/status/pending/rules/audit/test/sync/审批/notify/menu…）
   * 直接返回自己的 `rich`；其余指令（包括用法提示、错误提示）在这里包成统一卡片，
   * 正文沿用原文本（纯文本降级等价），并附上常用入口按钮。
   * 后续为这些指令做定制卡时，替换掉各自的 handler 即可。
   */
  private ensureCard(
    command: string,
    result: CommandResult,
    groupId: string | undefined,
    userId: string,
  ): CommandResult {
    if (result.rich) {
      return result;
    }
    const title = COMMAND_CARD_TITLES[command] ?? "指令结果";
    const nav: CardButton[] = [];
    if (groupId) {
      nav.push(viewButton("pending", "待审批", "pending", "page", groupId, 1));
      nav.push(viewButton("rules", "群规则", "rules", "view", groupId));
    }
    nav.push(viewButton("help", "指令帮助", "help", "home"));
    const card = cardFromText(title, result.text, {
      rows: [nav],
      ...(groupId ? { buttonHint: "常用入口：" } : {}),
      footer: ["按钮不可用时可直接输入指令。"],
    });
    // §B4：`silent` 必须原样保留，否则「群里静默、结果只私信」会在兜底包卡片时失效。
    return {
      ok: result.ok,
      text: card.text,
      rich: card.rich,
      ...(result.silent !== undefined ? { silent: result.silent } : {}),
    };
  }

  /**
   * 结果反馈里的操作人提及：**群内**用 QQ 提及单独一行（`<@!userId>`），私聊不显示
   * （私聊里操作人就是接收者本人）。提及必须原样输出，不能做 markdown 转义。
   */
  private mention(replyGroupId: string | undefined, userId: string): string {
    return replyGroupId ? `<@!${userId}>\n` : "";
  }

  /**
   * 把反馈文案渲染成卡片行：如果第一行是提及（`<@!...>`），保持它单独成行且不转义，
   * 其余内容作为「**结果**：…」展示。
   */
  private renderNotice(notice: string | undefined): string[] {
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

  /**
   * 定制卡包装：用指定标题、按钮与页脚包装已有指令结果。
   *
   * 正文沿用 `result.text`，因此**纯文本降级与旧输出等价**；已经自带卡片的直接返回。
   * 这样给某条指令做"定制布局"时不需要改它的业务逻辑。
   */
  private cardify(
    title: string,
    result: CommandResult,
    rows: readonly (readonly CardButton[])[],
    footer: readonly string[] = ["按钮不可用时可直接输入指令。"],
    buttonHint = "相关入口：",
  ): CommandResult {
    if (result.rich) {
      return result;
    }
    const card = cardFromText(title, result.text, { rows, footer, buttonHint });
    return {
      ok: result.ok,
      text: card.text,
      rich: card.rich,
      ...(result.silent !== undefined ? { silent: result.silent } : {}),
    };
  }

  /** 定制卡包装（异步结果版：handler 是 async 时用）。 */
  private async cardifyAsync(
    title: string,
    result: Promise<CommandResult>,
    rows: readonly (readonly CardButton[])[],
    footer?: readonly string[],
    buttonHint?: string,
  ): Promise<CommandResult> {
    return this.cardify(title, await result, rows, footer, buttonHint);
  }

  /** 领域子模块共享依赖（R1 拆分）：门面只负责组装，业务在 commands/* 里。 */
  private context(): AdminCommandContext {
    return {
      permissions: this.permissions,
      joinAudit: this.joinAudit,
      configStore: this.configStore,
      joinApproval: this.joinApproval,
      joinSync: this.joinSync,
      auditLog: this.auditLog,
      joinRules: this.joinRules,
      groupMessageMode: this.groupMessageMode,
      identityMap: this.identityMap,
      display: this.display,
      userProfiles: this.userProfiles,
      classAliases: this.classAliases,
      activity: this.activity,
      activityCards: this.activityCards,
      notifications: this.notifications,
      richMessages: this.richMessages,
    };
  }
  /** 指令分发表（返回值统一交给 `ensureCard` 保证是卡片）。 */
  private async dispatchCommand(
    command: string,
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    switch (command) {
      case "help":
      case "帮助":
        return this.handleHelp(groupId, userId, parts);
      case "menu":
      case "菜单":
        return this.handleMenu(groupId, userId, parts);
      case "myperm":
      case "我的权限":
        return this.cardify(
          "我的权限",
          this.handleMyPermission(groupId, userId),
          [
            [
              viewButton("profile", "我的资料", "cmd", "run", "/profile"),
              viewButton("activity", "活动", "activity", "page", groupId ?? "", 1),
              viewButton("help", "指令帮助", "help", "home"),
            ],
          ],
          ["详细用法：/help"],
        );
      case "bind":
      case "绑定":
        return this.cardifyAsync(
          "绑定",
          this.handleBind(groupId, userId, parts),
          [
            [
              viewButton("myperm", "我的权限", "cmd", "run", "/myperm"),
              viewButton("help", "绑定帮助", "help", "topic", "bind"),
            ],
          ],
          ["详细用法：/help"],
        );
      case "alias":
      case "别名":
        return this.cardify(
          "班级别名表",
          aliasCard(this.context(), userId, parts),
          [
            [
              viewButton("refresh", "刷新列表", "cmd", "run", "/alias"),
              viewButton("help", "查询帮助", "help", "topic", "alias"),
            ],
          ],
          ["按钮不可用时可直接输入指令。"],
        );
      case "whois":
      case "查询":
        return this.whoisCard(groupId, userId, parts);
      case "perm":
      case "权限":
        return this.cardify(
          "权限配置",
          this.handlePermissionConfig(groupId, userId, parts),
          [
            [
              viewButton("help", "权限帮助", "help", "topic", "perm"),
              viewButton("myperm", "我的权限", "cmd", "run", "/myperm"),
            ],
          ],
          ["详细用法：/help"],
        );
      case "pending":
      case "待审批":
        return this.handlePending(groupId, userId, parts);
      case "sync":
      case "同步":
        return this.handleSync(groupId, userId, parts);
      case "notify":
      case "push":
      case "推送":
      case "订阅":
        return this.handleNotify(groupId, userId, parts);
      case "profile":
      case "资料":
        return this.cardify(
          "个人资料",
          this.handleProfile(userId, parts),
          [
            [
              viewButton("activity", "活动", "activity", "page", groupId ?? "", 1),
              viewButton("help", "资料帮助", "help", "topic", "profile"),
            ],
          ],
          ["详细用法：/help"],
        );
      case "activity":
      case "活动":
        return this.handleActivity(groupId, userId, parts);
      case "approve":
      case "通过":
        return this.handleApprove(groupId, userId, parts);
      case "reject":
      case "拒绝":
        return this.handleReject(groupId, userId, parts);
      case "rules":
      case "规则":
        return this.handleRules(groupId, userId, parts);
      case "audit":
      case "日志":
        return this.handleAudit(groupId, userId, parts);
      case "status":
      case "状态":
        return this.handleStatus(groupId, userId, parts);
      case "test":
      case "测试":
        return this.handleTest(groupId, userId);
      case "testmenu":
        return this.handleTestMenu(userId, parts);
      case "testat":
      case "@测试":
        return this.handleTestAt(groupId, userId, parts);
      default:
        return this.unknownCommandResult(groupId, userId, parts[0]);
    }
  }

  private async handleBind(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const target = normalize(parts[1]);
    if (!target) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "/bind qq <QQ号>\n" +
          "/bind group <群号>\n" +
          "/bind user <userId> <QQ号>（超管）\n" +
          "/bind groupid <group_openid> <群号>（超管）",
      };
    }

    if (target === "qq") {
      const qq = parts[2]?.trim();
      if (!qq) {
        return { ok: false, text: "用法：/bind qq <QQ号>" };
      }
      try {
        await this.identityMap?.bindUser(userId, qq);
      } catch (error) {
        log.error("bind user qq failed", {
          userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound user qq", { userId, qq });
      return {
        ok: true,
        text: `已绑定：QQ ${qq}`,
      };
    }

    if (target === "group") {
      const groupNumber = parts[2]?.trim();
      if (!groupId || !groupNumber) {
        return {
          ok: false,
          text: "该指令需要在群内使用。用法：/bind group <群号>",
        };
      }
      if (
        !this.permissions.canApproveJoin(userId, groupId) &&
        !this.permissions.isSuperAdmin(userId)
      ) {
        return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
      }
      try {
        await this.identityMap?.bindGroup(groupId, groupNumber);
      } catch (error) {
        log.error("bind group number failed", {
          groupId,
          userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound group number", { groupId, groupNumber, userId });
      return {
        ok: true,
        text: `已绑定：群号 ${groupNumber}`,
      };
    }

    if (target === "user") {
      if (!this.permissions.isSuperAdmin(userId)) {
        return { ok: false, text: "权限不足：仅超级管理员可以绑定任意用户。" };
      }
      const officialId = parts[2]?.trim();
      const qq = parts[3]?.trim();
      if (!officialId || !qq) {
        return { ok: false, text: "用法：/bind user <userId> <QQ号>" };
      }
      try {
        await this.identityMap?.bindUser(officialId, qq);
      } catch (error) {
        log.error("bind user failed", {
          officialId,
          operator: userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound user qq", { officialId, qq, operator: userId });
      return {
        ok: true,
        text: `已绑定：QQ ${qq}`,
      };
    }

    if (target === "groupid") {
      if (!this.permissions.isSuperAdmin(userId)) {
        return { ok: false, text: "权限不足：仅超级管理员可以绑定任意群。" };
      }
      const officialId = parts[2]?.trim();
      const groupNumber = parts[3]?.trim();
      if (!officialId || !groupNumber) {
        return { ok: false, text: "用法：/bind groupid <group_openid> <群号>" };
      }
      try {
        await this.identityMap?.bindGroup(officialId, groupNumber);
      } catch (error) {
        log.error("bind group failed", {
          officialId,
          operator: userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound group number", {
        officialId,
        groupNumber,
        operator: userId,
      });
      return {
        ok: true,
        text: `已绑定：群号 ${groupNumber}`,
      };
    }

    return {
      ok: false,
      text:
        "未知绑定类型。用法：\n" +
        "/bind qq <QQ号>\n" +
        "/bind group <群号>\n" +
        "/bind user <userId> <QQ号>（超管）\n" +
        "/bind groupid <group_openid> <群号>（超管）",
    };
  }

  private handleWhois(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：仅超级管理员可以查询映射。" };
    }
    if (!this.identityMap) {
      return { ok: false, text: "映射服务未启用。" };
    }
    if (normalize(parts[1]) === "profile" || normalize(parts[1]) === "资料") {
      return this.handleWhoisProfile(parts.slice(2));
    }
    const input = parts[1]?.trim();
    if (!input) {
      // 不带参数：直接查当前上下文 —— 群聊查当前群，私聊查你自己
      if (groupId) {
        const groupNumber =
          this.identityMap.getGroupNumber(groupId) ?? "（未绑定）";
        const shortCode = this.display
          ? `\n短码：${this.display.group(groupId)}`
          : "";
        return {
          ok: true,
          text: `类型：群（当前群）\n群 ID：${groupId}\n群号：${groupNumber}${shortCode}`,
        };
      }
      const qq = this.identityMap.getQq(userId) ?? "（未绑定）";
      const shortCode = this.display
        ? `\n短码：${this.display.user(userId)}`
        : "";
      return {
        ok: true,
        text: `类型：用户（你自己）\nuserId：${userId}\nQQ：${qq}${shortCode}`,
      };
    }

    // 群内 @ 指定目标：官方 at 段是 `<@!openid>`，可以直接当 userId 用
    const mentionedId = parseMentionTarget(input);
    if (mentionedId) {
      return this.userMapping(mentionedId, "用户（群内 @）");
    }
    if (input.startsWith("@")) {
      return { ok: false, text: WHOIS_MENTION_HINT };
    }

    // `#短码`：唯一允许查看真实系统 id 的入口
    const code = this.display?.resolveCode(input);
    if (code) {
      const label = `#${code.code}`;
      if (code.kind === "join_request") {
        const lines = [
          "类型：入群申请",
          `短码：${label}`,
          `真实申请 ID：${code.targetId}`,
        ];
        if (this.joinAudit.has(code.targetId)) {
          const request = this.joinAudit.get(code.targetId);
          lines.push(
            `群：${this.displayGroup(request.groupId)}`,
            `申请人：${this.displayUser(request.userId)}`,
            `理由：${request.reason || "（未填写）"}`,
            `状态：${request.status}`,
            `申请时间：${formatTime(request.createdAt)}`,
          );
          if (request.reviewedAt) {
            lines.push(`处理时间：${formatTime(request.reviewedAt)}`);
          }
          if (request.reviewerId) {
            lines.push(
              `处理人：${
                request.reviewerId === EXPIRY_ACTOR_ID
                  ? "系统（自动过期）"
                  : request.reviewerId === "bot:auto"
                    ? "机器人（按入群规则自动处理）"
                    : this.displayUser(request.reviewerId)
              }`,
            );
          }
          lines.push(
            request.status === "pending"
              ? "本地队列：待审批中"
              : "本地队列：已不在队列（/pending 不会显示）",
          );
        } else {
          lines.push("本地队列：无记录（可能已被保留策略清理）");
        }
        return { ok: true, text: lines.join("\n") };
      }
      if (code.kind === "user") {
        const qq = this.identityMap.getQq(code.targetId);
        return {
          ok: true,
          text:
            `类型：用户\n短码：${label}\n真实 userId：${code.targetId}\n` +
            `QQ：${qq ?? "（未绑定）"}`,
        };
      }
      const groupNumber = this.identityMap.getGroupNumber(code.targetId);
      return {
        ok: true,
        text:
          `类型：群\n短码：${label}\n真实 group_openid：${code.targetId}\n` +
          `群号：${groupNumber ?? "（未绑定）"}`,
      };
    }

    const resolvedUserId = this.identityMap.resolveUserId(input);
    if (resolvedUserId) {
      const qq = this.identityMap.getQq(resolvedUserId) ?? "（未绑定）";
      const shortCode = this.display
        ? `\n短码：${this.display.user(resolvedUserId)}`
        : "";
      return {
        ok: true,
        text: `类型：用户\nuserId：${resolvedUserId}\nQQ：${qq}${shortCode}`,
      };
    }
    const resolvedGroupId = this.identityMap.resolveGroupId(input);
    if (resolvedGroupId) {
      const groupNumber =
        this.identityMap.getGroupNumber(resolvedGroupId) ?? "（未绑定）";
      const shortCode = this.display
        ? `\n短码：${this.display.group(resolvedGroupId)}`
        : "";
      return {
        ok: true,
        text: `类型：群\n群 ID：${resolvedGroupId}\n群号：${groupNumber}${shortCode}`,
      };
    }
    return { ok: false, text: `未找到映射。\n\n${WHOIS_USAGE}` };
  }

  /** 用户类映射的统一输出（群内 @ / 短码 / QQ号 都用它）。 */
  private userMapping(userId: string, label = "用户"): CommandResult {
    const qq = this.identityMap?.getQq(userId) ?? "（未绑定）";
    const shortCode = this.display ? `\n短码：${this.display.user(userId)}` : "";
    return {
      ok: true,
      text: `类型：${label}\nuserId：${userId}\nQQ：${qq}${shortCode}`,
    };
  }

  /**
   * `/whois` 的投递层：**结果只走私信**。
   *
   * - 私聊里发指令：直接回复（本来就只有本人能看到）；
   * - 群聊里发指令：结果私信给操作人，群里只回一张不含任何内容的提示卡；
   * - 私信发送失败：只提示「先私聊机器人再试」，**绝不在群里降级显示结果**；
   * - 权限不足 / 用法 / 未找到映射这类不含隐私的结果，仍在原处直接回。
   */
  private async whoisCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const rows = [
      [
        viewButton("myperm", "我的权限", "cmd", "run", "/myperm"),
        viewButton("help", "查询帮助", "help", "topic", "whois"),
      ],
    ];
    const result = this.handleWhois(groupId, userId, parts);
    const card = this.cardify("映射查询", result, rows, ["详细用法：/help"]);
    if (!groupId || !result.ok) {
      return card;
    }
    const rich = card.rich;
    if (!rich) {
      return card;
    }
    const sender = this.notifications;
    const sent = sender
      ? await sender.sendPrivateCard(userId, rich)
      : { ok: false, detail: "私信通道未启用" };
    const mention = this.mention(groupId, userId).trimEnd();
    const body = sent.ok
      ? "**结果**：已私信发送，请在私聊里查看。\n（/whois 的结果涉及隐私，不在群里展示）"
      : `**结果**：私信发送失败（${sent.detail}），请先私聊机器人再试。\n（/whois 的结果涉及隐私，不会在群里展示）`;
    const notice = renderCard({
      title: "映射查询",
      lines: [...(mention ? [mention] : []), body],
      rows,
      footer: ["详细用法：/help"],
    });
    return { ok: true, text: notice.text, rich: notice };
  }

  /** 把 `@`（官方 at 段）/ QQ号 / userId / `#短码` 解析成 userId（仅用户类）。 */
  private resolveWhoisTargetUserId(target: string): string | undefined {
    const mentioned = parseMentionTarget(target);
    if (mentioned) {
      return mentioned;
    }
    if (target.startsWith("#")) {
      const code = this.display?.resolveCode(target);
      return code && code.kind === "user" ? code.targetId : undefined;
    }
    return this.identityMap?.resolveUserId(target);
  }

  /** `/whois profile <@某人|QQ号|userId|#短码>`：QQ↔userId↔短码 + 个人资料（仅超级管理员）。 */
  private handleWhoisProfile(parts: readonly string[]): CommandResult {
    const target = parts[0]?.trim();
    if (!target) {
      return { ok: false, text: WHOIS_USAGE };
    }
    const resolvedUserId = this.resolveWhoisTargetUserId(target);
    if (!resolvedUserId) {
      return {
        ok: false,
        text: target.startsWith("@")
          ? WHOIS_MENTION_HINT
          : `未找到该用户的映射。支持：QQ号 / userId / #用户短码。\n\n${WHOIS_USAGE}`,
      };
    }
    const lines = ["类型：用户资料"];
    const qq = this.identityMap?.getQq(resolvedUserId) ?? "（未绑定）";
    lines.push(`userId：${resolvedUserId}`, `QQ：${qq}`);
    if (this.display) {
      lines.push(`短码：${this.display.user(resolvedUserId)}`);
    }
    const profile = this.userProfiles?.get(resolvedUserId);
    if (!this.userProfiles) {
      lines.push("", "个人资料服务未启用。");
      return { ok: true, text: lines.join("\n") };
    }
    if (!profile) {
      lines.push("", "个人资料：尚未填写");
      return { ok: true, text: lines.join("\n") };
    }
    const grade =
      profile.studentId && profile.year ? `（${profile.year} 级）` : "";
    lines.push(
      "",
      `姓名：${profile.name || "（未填）"}`,
      `学号：${profile.studentId || "（未填）"}${grade}`,
      `班级：${profile.className || "（未填）"}`,
      `学院：${profile.college || "（未填）"}`,
    );
    return { ok: true, text: lines.join("\n") };
  }

  /**
   * 解析审批目标（`/approve`、`/reject` 共用）：
   *
   * - 群内：`/approve <申请>`；
   * - 私信带群：`/approve <群号|#群短码> <申请>`；
   * - 私信不带群：`/approve <申请>`，从本地申请记录反查所属群（短码唯一即可定位）。
   */
  private resolveReviewTarget(
    groupId: string | undefined,
    parts: readonly string[],
  ): {
    targetGroupId: string | undefined;
    requestId: string | undefined;
    reasonParts: readonly string[];
  } {
    if (groupId) {
      return {
        targetGroupId: groupId,
        requestId: this.resolveRequestId(parts[1]),
        reasonParts: parts.slice(2),
      };
    }
    const groupFromFirst = this.resolveTargetGroupId(undefined, parts[1]);
    if (groupFromFirst) {
      return {
        targetGroupId: groupFromFirst,
        requestId: this.resolveRequestId(parts[2]),
        reasonParts: parts.slice(3),
      };
    }
    const requestId = this.resolveRequestId(parts[1]);
    let targetGroupId: string | undefined;
    if (requestId) {
      try {
        targetGroupId = this.joinAudit.get(requestId).groupId;
      } catch {
        targetGroupId = undefined;
      }
    }
    return { targetGroupId, requestId, reasonParts: parts.slice(2) };
  }

  private resolveUserId(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    // `#短码` 优先；否则按 QQ号/openid 解析
    const fromCode = this.display?.resolveUser(trimmed);
    if (fromCode) {
      return fromCode;
    }
    return this.identityMap?.resolveUserId(trimmed) ?? trimmed;
  }

  private resolveTargetGroupId(
    groupId: string | undefined,
    input: string | undefined,
  ): string | undefined {
    if (groupId) {
      return groupId;
    }
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    const fromCode = this.display?.resolveGroup(trimmed);
    if (fromCode) {
      return fromCode;
    }
    if (!this.identityMap) {
      return trimmed;
    }
    return this.identityMap.resolveGroupId(trimmed);
  }

  /** 申请参数：`#短码`（推荐）或完整 join_request_id。 */
  private resolveRequestId(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    return this.display?.resolveRequest(trimmed) ?? trimmed;
  }

  /**
   * `/help` 列出有权限执行的指令；`/help <主题>` 展示该指令的详细用法。
   *
   * 主题详情同样做权限过滤：无权限时只提示所需权限，不展示具体命令，
   * 与「/help 只显示有权限执行的指令」保持一致。
   */
  /** 主菜单富消息（首次私信推送与未知指令回复复用）。 */
  public mainMenu(groupId: string | undefined, userId: string): RichMessage {
    return buildMenu("main", this.menuContext(groupId, userId)).message;
  }

  /** 回调 renderer 用：渲染菜单的某一级（`cb:menu:open:<section>`）。 */
  public menuMessage(
    section: string | undefined,
    groupId: string | undefined,
    userId: string,
  ): RichMessage {
    return buildMenu(
      findMenuSection(section) ?? "main",
      this.menuContext(groupId, userId),
    ).message;
  }

  /**
   * `/help [主题]`：指令列表卡 / 主题详情卡。
   *
   * 正文沿用原来的帮助文本（纯文本降级因此与旧输出等价），按钮按标准分类：
   * 菜单入口与主题查看都是**回调**（点击即出卡），无需用户再发指令。
   */
  public helpCard(
    groupId: string | undefined,
    userId: string,
    topicQuery?: string,
  ): CardResult {
    const access = resolveMenuAccess(this.menuContext(groupId, userId));
    /** 完整指令列表卡（正文沿用 buildHelp，含未绑定/未绑群提示）。 */
    const listCard = (): CardResult => {
      const card = renderCard({
        title: "全部可用指令",
        lines: this.buildHelp(groupId, userId).split("\n"),
        rows: [[viewButton("home", "返回帮助", "help", "home")]],
        footer: ["某个指令的详细用法：/help <指令>"],
      });
      return { ok: true, text: card.text, rich: card };
    };
    const isBound = this.identityMap
      ? Boolean(this.identityMap.getQq(userId))
      : true;
    const groupBound =
      groupId === undefined || !this.identityMap
        ? true
        : Boolean(this.identityMap.getGroupNumber(groupId));

    if (!topicQuery) {
      // 未绑定 QQ 号 / 本群未绑定：直接给完整列表卡，正文里带绑定提示
      if (!isBound || !groupBound) {
        return listCard();
      }
      // 伞形卡：只给分类入口，完整列表在 `/help all`（避免一张卡 30 行）
      const menuRow: CardButton[] = [
        viewButton("sys", "系统菜单", "menu", "open", "sys"),
      ];
      if (access.canModerate) {
        menuRow.push(viewButton("admin", "管理菜单", "menu", "open", "admin"));
      }
      if (access.isSuperAdmin) {
        menuRow.push(viewButton("super", "超管菜单", "menu", "open", "super"));
      }
      const card = renderCard({
        title: "指令帮助",
        lines: [
          "按分类查看你有权限使用的指令。",
          "完整指令列表：/help all",
        ],
      rows: [
        menuRow,
        [
          viewButton("all", "全部指令", "help", "list"),
          viewButton("topic-rules", "群规则", "help", "topic", "rules"),
          viewButton("topic-approve", "审批", "help", "topic", "approve"),
        ],
        [
          viewButton("topic-bind", "绑定", "help", "topic", "bind"),
          viewButton("topic-menu", "菜单", "help", "topic", "menu"),
        ],
      ],
        buttonHint: "请选择分类：",
        footer: ["某个指令的详细用法：/help <指令>"],
      });
      return { ok: true, text: card.text, rich: card };
    }

    if (topicQuery === "all" || topicQuery === "全部") {
      return listCard();
    }

    const topic = findHelpTopic(topicQuery);
    if (!topic) {
      const card = renderCard({
        title: "指令帮助",
        lines: [
          `未找到「${topicQuery}」的帮助。`,
          "用法：/help <指令>，例如 /help rules、/help bind、/help perm",
          "",
          ...this.buildHelp(groupId, userId).split("\n"),
        ],
        rows: [[viewButton("home", "返回帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const context = {
      permissions: this.permissions,
      configStore: this.configStore,
      identityMap: this.identityMap,
      groupId,
      userId,
    };
    if (!topic.allows(context)) {
      const card = renderCard({
        title: "权限不足",
        lines: [
          `/${topic.name} 需要${topic.requirement}。`,
          "权限由全局超级管理员通过 /perm 配置。",
        ],
        rows: [[viewButton("home", "返回帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const rows: CardButton[] = [viewButton("home", "返回帮助", "help", "home")];
    if (topic.name === "rules" && groupId) {
      rows.unshift(
        viewButton("view", "查看当前规则", "rules", "view", groupId),
      );
    }
    if (topic.name === "menu") {
      rows.unshift(viewButton("menu", "打开菜单", "menu", "open", "main"));
    }
    const card = renderCard({
      title: `/${topic.name} · ${topic.title}`,
      lines: this.renderHelpTopic(topic, context).split("\n"),
      rows: [rows],
      buttonHint: "相关入口：",
    });
    return { ok: true, text: card.text, rich: card };
  }

  /** `/status <群号|#群短码>`：运行状态卡 + 常用入口。 */
  public statusCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CardResult {
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "运行状态",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/status <群号|#群短码>",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const config = this.configStore.get(targetGroupId);
    const text = [
      `群 ${this.displayGroup(targetGroupId)} 状态：`,
      `机器人启用：${config.enabled}`,
      `消息过滤：${config.wordFilterEnabled}`,
      `全量消息模式：${this.groupMessageMode?.get(targetGroupId) ?? "unknown"}`,
      `入群审核：${config.joinAuditEnabled}`,
      `导出功能：${config.exportEnabled}`,
      `禁言时长：${config.muteDurationSeconds} 秒`,
    ].join("\n");
    return cardFromText("运行状态", text, {
      rows: [
        [
          viewButton("refresh", "刷新", "status", "view", targetGroupId),
          viewButton("pending", "待审批", "pending", "page", targetGroupId, 1),
          viewButton("rules", "群规则", "rules", "view", targetGroupId),
        ],
        [
          viewButton("help", "指令帮助", "help", "home"),
          actionButton("test", "自检", "/test"),
        ],
      ],
      buttonHint: "常用入口：",
      footer: [`本群：${this.displayGroup(targetGroupId)}`],
    });
  }

  /**
   * `/pending [群号|#群短码] [+页码]`：待审批列表卡。
   *
   * 每页 3 条（含审核意见会占多行），每条给「通过 / 拒绝」**指令按钮**（走正常审批权限
   * 与二次确认），翻页用**回调按钮**；纯文本降级给出 `/pending +<页码>` 指令。
   */
  public pendingCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
    notice?: string,
  ): CardResult {
    const { page, rest } = extractPageToken(parts);
    const targetGroupId = this.resolveTargetGroupId(groupId, rest[0]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "待审批入群申请",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/pending <群号|#群短码> [+页码]",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const groupLabel = this.displayGroup(targetGroupId);
    const pending = this.joinAudit.pending(targetGroupId);
    if (pending.length === 0) {
      return cardFromText(
        "待审批入群申请",
        [
          ...this.renderNotice(notice),
          `群 ${groupLabel}：当前没有待审批入群申请。`,
        ].join("\n"),
        {
          rows: [
            [viewButton("refresh", "刷新", "pending", "page", targetGroupId, 1)],
          ],
          footer: [`本群：${groupLabel}`],
        },
      );
    }

    const pageSize = 3;
    const pageCount = Math.max(1, Math.ceil(pending.length / pageSize));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = pending.slice((current - 1) * pageSize, current * pageSize);
    const config = this.configStore.get(targetGroupId);
    const withOpinion =
      config.joinReviewOpinion && this.joinRules !== undefined;

    const lines = [
      `**群**：${groupLabel}`,
      `**待审批**：${pending.length} 条 · 第 ${current} / ${pageCount} 页`,
      ...this.renderNotice(notice),
    ];
    const rows: CardButton[][] = [];
    for (const request of slice) {
      const code = this.displayRequest(request.requestId);
      lines.push(
        "",
        `**${escapeCardText(code)}** · 申请人：${escapeCardText(this.displayUser(request.userId))}`,
        `理由：${escapeCardText(request.reason) || "（未填写）"}`,
      );
      if (withOpinion) {
        const evaluation = this.joinRules?.evaluate(request.reason, {
          mode: config.joinDecision,
          requireClass: config.joinRequireClass,
          requireName: config.joinRequireName,
          answerPattern: config.joinAnswerPattern,
          opinionEnabled: true,
        });
        if (evaluation?.opinion) {
          lines.push(...quoteCardLines(evaluation.opinion));
        }
      }
      rows.push([
        // 「通过」是固定动作（无需参数）→ 回调自动完成，并回一张刷新后的列表
        {
          ...viewButton(
            `approve-${code}`,
            "通过",
            "pending",
            "approve",
            targetGroupId,
            request.requestId,
            current,
          ),
          style: 1,
        },
        // 「拒绝」支持可选原因 → 保留指令按钮，用户可在发送前补上原因
        actionButton(`reject-${code}`, "拒绝", `/reject ${code}`, {
          style: 3,
          modal: {
            content: "确认拒绝该入群申请？（可先补上原因）",
            confirmText: "拒绝",
            cancelText: "取消",
          },
        }),
      ]);
    }

    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(
        viewButton("prev", "上一页", "pending", "page", targetGroupId, current - 1),
      );
    }
    if (current < pageCount) {
      paging.push(
        viewButton("next", "下一页", "pending", "page", targetGroupId, current + 1),
      );
    }
    paging.push(
      viewButton("refresh", "刷新", "pending", "page", targetGroupId, current),
    );
    rows.push(paging);

    const footer: string[] = [];
    if (current < pageCount) {
      footer.push(`下一页：/pending +${current + 1}`);
    }
    if (current > 1) {
      footer.push(`上一页：/pending +${current - 1}`);
    }

    return cardFromText("待审批入群申请", lines.join("\n"), {
      rows,
      buttonHint: "点击审批：",
      footer,
    });
  }

  /**
   * 回调：固定动作「通过入群申请」。
   *
   * 无需参数，因此走回调自动完成：校验权限 → 调官方审批接口 → 回一张**刷新后的**列表卡
   * （带「已通过 #短码」结果行）。拒绝因为支持可选原因，仍然是指令按钮。
   */
  public async approveCard(
    targetGroupId: string,
    requestId: string,
    userId: string,
    page = 1,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const back = viewButton("back", "返回待审批", "pending", "page", targetGroupId, page);
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["通过入群申请需要群管理员或以上权限。"],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        const card = renderCard({
          title: "审批失败",
          lines: ["申请不属于该群。"],
          rows: [[back]],
        });
        return { ok: false, text: card.text, rich: card };
      }
      await this.joinApproval.approve(targetGroupId, requestId, userId);
    } catch (error) {
      log.warn("approve via callback failed", {
        requestId,
        error: formatError(error),
      });
      const card = renderCard({
        title: "审批失败",
        lines: [formatError(error)],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("approved join request via callback", { requestId, userId });
    return this.pendingCard(
      undefined,
      userId,
      ["pending", targetGroupId, `+${page}`],
      `${this.mention(replyGroupId, userId)}已通过 ${this.displayRequest(requestId)}`,
    );
  }

  /**
   * `/rules [群号|#群短码]`：规则概览卡（§C 重构）。
   *
   * 正文标明**本群覆盖了哪些字段**（其余继承全局），入口是 5 个子卡：
   * 开关设置 / 入群审核 / 违规处理 / 关键词 / 更多设置；
   * 末行是 `全局规则`（超管）/ `恢复全部继承`（二次确认）/ `规则帮助`。
   * 所有入口都是回调，点击即出对应子卡。
   */
  public rulesCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
    notice?: string,
  ): CardResult {
    if (isGlobalTarget(parts[1])) {
      return this.globalRulesCard(userId, 1);
    }
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      if (!parts[1] && this.permissions.isSuperAdmin(userId)) {
        return this.globalRulesCard(userId, 1);
      }
      const card = renderCard({
        title: "群规则",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/rules <群号|#群短码>；全局默认规则：/rules all",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限（查看）／群管理员或以上（修改）。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const config = this.configStore.get(targetGroupId);
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);

    const overridden = this.configStore.overriddenFields(targetGroupId);
    const overrideNames = [...overridden]
      .map((field) => ruleFieldLabel(field))
      .filter((label) => label.length > 0);
    const inheritanceLine =
      overrideNames.length > 0
        ? `**本群覆盖**：${overrideNames.join("、")}（其余继承全局）`
        : "**本群覆盖**：全部继承全局";

    const rows: CardButton[][] = [];
    if (canManage) {
      // 一行按钮文字总长 ≤12 字（见 docs/CARD-STANDARD.md）：
      // 4+4+4=12 刚好，再加一个字就超。
      rows.push([
        viewButton("panel-toggle", "开关设置", "rules", "panel", targetGroupId, "toggle"),
        viewButton("panel-decision", "入群审核", "rules", "panel", targetGroupId, "decision"),
        viewButton("panel-punish", "违规处理", "rules", "panel", targetGroupId, "punish"),
      ]);
      rows.push([
        viewButton("panel-keywords", "关键词", "rules", "panel", targetGroupId, "keyword"),
        viewButton("panel-roster", "名单筛选", "rules", "panel", targetGroupId, "roster"),
      ]);
    }
    const lastRow: CardButton[] = [];
    if (canManage) {
      rows.push([
        viewButton("panel-more", "更多设置", "rules", "panel", targetGroupId, "more"),
        viewButtonWithOptions(
          "resetAll",
          "恢复全部继承",
          encodeCallback("rules", "resetAll", targetGroupId, "1"),
          { modal: confirmRuleResetModal("本群全部规则") },
        ),
      ]);
    }
    if (this.permissions.isSuperAdmin(userId)) {
      lastRow.push(viewButton("global", "全局规则", "rules", "all"));
    }
    lastRow.push(viewButton("help", "规则帮助", "help", "topic", "rules"));
    rows.push(lastRow);

    const lines = [
      ...this.renderNotice(notice),
      inheritanceLine,
      "",
      `**关键词**：${config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）"}`,
      `**警告文案**：${config.warningMessage}`,
      `**禁言时长**：${config.muteDurationSeconds} 秒`,
      `**入群要求**：班级 ${config.joinRequireClass} · 姓名 ${config.joinRequireName} · 审核意见 ${config.joinReviewOpinion}`,
      `**名单筛选**：学院 ${config.allowColleges.length}/${config.denyColleges.length} · 年级 ${config.allowYears.length}/${config.denyYears.length}`,
      `**机器人启用**：${config.enabled ? "开" : "关"} · 导出 ${config.exportEnabled ? "开" : "关"}`,
    ];

    return cardFromText("群规则", lines.join("\n"), {
      rows,
      buttonHint: canManage ? "设置入口（点击即生效）：" : "相关入口：",
      footer: [
        `本群：${this.displayGroup(targetGroupId)}`,
        "完整字段用法：/help rules",
        "「恢复本页继承」只清本页字段；「恢复全部继承」清空本群全部覆盖。",
      ],
    });
  }

  /**
   * `/activity [list] [群号] [+页码]`：活动列表卡（按状态分组）。
   *
   * 每页 3 个活动，每个活动一行按钮：`详情` / `报名` / `管理`（仅管理者）/ `订阅`，
   * 全部是**回调**（点击即出卡/生效，不用再发消息）；翻页是回调，
   * 纯文本降级给出 `/activity list +<页码>`（`+` 前缀与群号区分）。
   */
  public activityListCard(
    targetGroupId: string,
    userId: string,
    page = 1,
    notice?: string,
  ): CardResult {
    const list = this.activity!.listActivities(targetGroupId);
    const groupLabel = this.displayGroup(targetGroupId);
    if (list.length === 0) {
      return cardFromText(
        "活动列表",
        [...this.renderNotice(notice), `群 ${groupLabel} 还没有活动。`].join("\n"),
        {
          rows: [
            [viewButton("refresh", "刷新", "activity", "page", targetGroupId, 1)],
          ],
          footer: [
            "创建活动：/activity create <标题>（群管理员或以上）",
            `本群：${groupLabel}`,
          ],
        },
      );
    }

    const size = 3;
    const pageCount = Math.max(1, Math.ceil(list.length / size));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = list.slice((current - 1) * size, current * size);
    const subscribed = this.isSubscribedTo(targetGroupId, userId);
    const canManageAny = list.some((activity) =>
      this.canManageActivity(userId, activity),
    );
    const lines = [
      ...this.renderNotice(notice),
      `**群**：${groupLabel}`,
      `**活动**：${list.length} 个 · 第 ${current} / ${pageCount} 页`,
      "",
    ];
    const rows: CardButton[][] = [];
    for (const groupName of ["报名中", "草稿", "已结束"] as const) {
      const group = slice.filter((activity) => listGroupOf(activity) === groupName);
      if (group.length === 0) {
        continue;
      }
      lines.push(`**${groupName}**`);
      for (const activity of group) {
        const count = this.activity!.listRegistrations(activity.activityId).length;
        const code = activityCode(activity);
        lines.push(
          `${escapeCardText(code)} ${escapeCardText(activity.title)} · 报名 ${count}${
            activity.capacity ? `/${activity.capacity}` : ""
          }`,
        );
        const row: CardButton[] = [
          viewButton(`info-${code}`, "详情", "activity", "info", code),
          viewButton(`join-${code}`, "报名", "activity", "join", code),
        ];
        if (this.canManageActivity(userId, activity)) {
          row.push(viewButton(`manage-${code}`, "管理", "activity", "manage", code));
        }
        row.push(
          viewButton(
            `subscribe-${code}`,
            subscribed ? "订阅 开" : "订阅 关",
            "activity",
            "subscribe",
            targetGroupId,
            subscribed ? "off" : "on",
          ),
        );
        rows.push(row);
      }
      lines.push("");
    }

    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(
        viewButton("prev", "上一页", "activity", "page", targetGroupId, current - 1),
      );
    }
    if (current < pageCount) {
      paging.push(
        viewButton("next", "下一页", "activity", "page", targetGroupId, current + 1),
      );
    }
    paging.push(
      viewButton("refresh", "刷新", "activity", "page", targetGroupId, current),
    );
    rows.push(paging);

    const footer: string[] = [];
    if (current < pageCount) {
      footer.push(`下一页：/activity list +${current + 1}`);
    }
    if (current > 1) {
      footer.push(`上一页：/activity list +${current - 1}`);
    }
    if (canManageAny) {
      footer.push("管理入口只在你有权限的活动上显示。");
    }

    return cardFromText("活动列表", lines.join("\n"), {
      rows,
      buttonHint: "点击操作：",
      footer,
    });
  }

  /**
   * `/notify`：入群申请推送订阅卡。
   *
   * 订阅开关是**回调**（固定动作，点击即订阅/退订并回一张带操作人的卡），
   * 「测试推送」也是回调（固定动作，触发一次自检卡片）。
   */
  public notifyCard(
    groupId: string | undefined,
    userId: string,
    notice?: string,
  ): CardResult {
    if (!this.notifications) {
      const card = renderCard({
        title: "入群申请推送",
        lines: ["推送服务未启用。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const scopes = this.notifications.listScopes(userId);
    const allOn = scopes.includes(NOTIFY_SCOPE_ALL);
    const lines = [
      ...this.renderNotice(notice),
      `**全部群**：${allOn ? "已开启" : "未开启"}`,
    ];
    if (groupId) {
      lines.push(
        `**当前群**：${scopes.includes(groupId) ? "已开启" : "未开启"}（${this.groupLabel(groupId)}）`,
      );
    }
    for (const scope of scopes.filter((item) => item !== NOTIFY_SCOPE_ALL)) {
      lines.push(`**已订阅**：群 ${this.groupLabel(scope)}`);
    }
    const reviewable = this.permissions.listReviewableGroups(userId);
    lines.push(
      reviewable.length > 0
        ? `**可审批的群**：${reviewable.map((id) => this.groupLabel(id)).join("、")}`
        : "**可审批的群**：无（入群审批需要群管理员或以上权限）",
    );
    lines.push("", "订阅后：有新的待人工处理申请会私聊推送卡片，可直接点按钮审批。");

    const rows: CardButton[][] = [];
    const switchRow: CardButton[] = [];
    if (groupId) {
      switchRow.push(
        viewButton(
          "thisGroup",
          `本群 ${scopes.includes(groupId) ? "关" : "开"}`,
          "notify",
          "toggle",
          groupId,
          scopes.includes(groupId) ? "off" : "on",
        ),
      );
    }
    switchRow.push(
      viewButton(
        "allGroups",
        `全部群 ${allOn ? "关" : "开"}`,
        "notify",
        "toggle",
        NOTIFY_SCOPE_ALL,
        allOn ? "off" : "on",
      ),
    );
    rows.push(switchRow);
    rows.push([
      viewButton("test", "测试推送", "notify", "test", groupId ?? ""),
      viewButton("refresh", "刷新", "notify", "view"),
    ]);

    return cardFromText("入群申请推送", lines.join("\n"), {
      rows,
      buttonHint: "点击即生效：",

    });
  }

  /** 回调：订阅开关（固定动作 → 自动生效并回刷新后的卡片）。 */
  public async notifyToggleCard(
    scope: string,
    enabled: boolean,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    if (!this.notifications) {
      return this.notifyCard(undefined, userId);
    }
    const result = this.applyNotify(userId, scope, enabled);
    const groupContext = scope === NOTIFY_SCOPE_ALL ? undefined : scope;
    if (!result.ok) {
      const card = renderCard({
        title: "推送未修改",
        lines: [result.text],
        rows: [
          [
            viewButton(
              "back",
              "返回推送设置",
              "notify",
              "view",
            ),
          ],
        ],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("notify scope updated via callback", { scope, enabled, userId });
    return this.notifyCard(
      groupContext,
      userId,
      `${this.mention(replyGroupId, userId)}${result.text.split("\n")[0]}`,
    );
  }

  /** 回调：测试推送（固定动作 → 直接给自己发一张测试卡并回结果）。 */
  public async notifyTestCard(
    groupId: string | undefined,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    if (!this.notifications) {
      return this.notifyCard(groupId, userId);
    }
    const result = await this.notifications.sendTestCard(userId, groupId);
    const notice = `${this.mention(replyGroupId, userId)}${result.text.split("\n")[0]}`;
    const card = this.notifyCard(groupId, userId, notice);
    return { ...card, ok: result.ok };
  }

  /**
   * `/audit [群号|#群短码] [每页数量] [+页码]`：审计记录卡。
   *
   * 正文沿用原格式（时间 / 动作 / 状态 / 操作人 / 对象），翻页为回调，
   * 纯文本降级给出 `/audit +<页码>`。
   */
  public auditCard(
    targetGroupId: string,
    userId: string,
    page = 1,
    limit = 20,
  ): CardResult {
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const groupLabel = this.displayGroup(targetGroupId);
    const size = limit > 0 ? limit : 20;
    // 最新的记录在前
    const all = this.auditLog.findByGroup(targetGroupId).slice().reverse();
    if (all.length === 0) {
      return cardFromText("审计记录", `群 ${groupLabel}：暂无审计记录。`, {
        rows: [
          [viewButton("refresh", "刷新", "audit", "page", targetGroupId, size, 1)],
        ],
        footer: [`本群：${groupLabel}`],
      });
    }
    const pageCount = Math.max(1, Math.ceil(all.length / size));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = all.slice((current - 1) * size, current * size);
    const lines = [
      `**群**：${groupLabel}`,
      `**审计记录**：${all.length} 条 · 第 ${current} / ${pageCount} 页（每页 ${size}）`,
    ];
    for (const record of slice) {
      const target = record.targetUserId
        ? ` → ${this.displayUser(record.targetUserId)}`
        : "";
      lines.push(
        `${formatTime(record.createdAt)} ${record.action} ${record.status}${
          record.actorId ? ` by ${this.displayUser(record.actorId)}` : ""
        }${target}`,
      );
    }
    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(
        viewButton("prev", "上一页", "audit", "page", targetGroupId, size, current - 1),
      );
    }
    if (current < pageCount) {
      paging.push(
        viewButton("next", "下一页", "audit", "page", targetGroupId, size, current + 1),
      );
    }
    paging.push(
      viewButton("refresh", "刷新", "audit", "page", targetGroupId, size, current),
    );
    const footer: string[] = [];
    if (current < pageCount) {
      footer.push(`下一页：/audit +${current + 1}`);
    }
    if (current > 1) {
      footer.push(`上一页：/audit +${current - 1}`);
    }
    footer.push(`本群：${groupLabel}`);
    return cardFromText("审计记录", lines.join("\n"), {
      rows: [paging],
      buttonHint: "翻页：",
      footer,
    });
  }

  /** `/test`：自检结果卡 + 常用入口。 */
  public testCard(groupId: string | undefined, userId: string): CardResult {
    if (!this.permissions.canReviewContent(userId, groupId ?? "")) {
      log.warn("test permission denied", { groupId, userId });
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("test command", { groupId, userId });
    const rows: CardButton[][] = [];
    if (groupId) {
      rows.push([
        viewButton("refresh", "刷新", "test", "view", groupId),
        viewButton("pending", "待审批", "pending", "page", groupId, 1),
        viewButton("rules", "群规则", "rules", "view", groupId),
      ]);
    } else {
      rows.push([viewButton("help", "指令帮助", "help", "home")]);
    }
    const lines = [
      "测试成功：机器人已响应。",
      groupId ? `**群**：${this.displayGroup(groupId)}` : "**当前会话**：私聊",
      `**用户**：${this.displayUser(userId)}`,
    ];
    if (groupId) {
      lines.push(`**待审批申请**：${this.joinAudit.pending(groupId).length}`);
      lines.push(
        `**全量消息模式**：${this.groupMessageMode?.get(groupId) ?? "unknown"}`,
      );
    }
    return cardFromText("自检结果", lines.join("\n"), {
      rows,
      buttonHint: "常用入口：",
      footer: ["机器人状态异常时：查看日志 logs/qq-group-ops.log"],
    });
  }

  /**
   * `/sync [群号|#群短码]` 与 `cb:sync:run`：同步官方待审批申请。
   *
   * 属于固定动作（无需参数），因此既能用指令触发，也能用回调自动完成；
   * 结果卡标明**操作人**，并给出「查看待审批」入口。
   */
  public async syncCard(
    targetGroupId: string,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const back = viewButton(
      "pending",
      "查看待审批",
      "pending",
      "page",
      targetGroupId,
      1,
    );
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    let pending;
    try {
      pending = await this.joinSync.syncGroup(targetGroupId);
    } catch (error) {
      log.warn("join sync failed", {
        groupId: targetGroupId,
        error: formatError(error),
      });
      const card = renderCard({
        title: "同步失败",
        lines: [
          ...(this.mention(replyGroupId, userId).trimEnd()
            ? [this.mention(replyGroupId, userId).trimEnd()]
            : []),
          formatError(error),
        ],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    await this.notifyPending(targetGroupId, pending).catch(() => undefined);
    const operator = this.mention(replyGroupId, userId).trimEnd();
    const lines = [
      ...(operator ? [operator] : []),
      `**群**：${this.displayGroup(targetGroupId)}`,
      `**结果**：已同步官方待审批申请，当前待审批 ${pending.length} 条`,
    ];
    for (const request of pending.slice(0, 5)) {
      const reason = request.reason ? ` 理由：${request.reason}` : "";
      lines.push(
        `- ${escapeCardText(this.displayRequest(request.requestId))} 用户：${escapeCardText(this.displayUser(request.userId))}${escapeCardText(reason)}`,
      );
    }
    if (pending.length > 5) {
      lines.push("（仅显示前 5 条，点下方按钮查看全部）");
    }
    return cardFromText("同步结果", lines.join("\n"), {
      rows: [[back]],
      footer: ["待审批列表每页 3 条，可翻页"],
    });
  }

  /** 审批结果卡（通过 / 拒绝），标明操作人并给回列表入口。 */
  private approvalResultCard(
    targetGroupId: string,
    userId: string,
    message: string,
    ok: boolean,
    replyGroupId?: string,
  ): CardResult {
    const card = renderCard({
      title: ok ? "审批结果" : "审批失败",
      lines: [
        ...(this.mention(replyGroupId, userId).trimEnd()
          ? [this.mention(replyGroupId, userId).trimEnd()]
          : []),
        message,
      ],
      rows: [
        [
          viewButton("back", "返回待审批", "pending", "page", targetGroupId, 1),
          viewButton("audit", "查看审计", "audit", "page", targetGroupId, 20, 1),
        ],
      ],

    });
    return { ok, text: card.text, rich: card };
  }
  /**
   * 子卡：开关设置 / 入群审核 / 违规处理 / 关键词 / 名单筛选 / 更多设置（§C 重构）。
   *
   * 按钮语义统一为**显示当前状态**（`关键词过滤 开`）；开关是回调，点击即切换并回到同一子卡；
   * 每张子卡底部是「恢复本页继承」（二次确认，清本页字段的覆盖）与「返回规则」。
   */
  public rulesPanelCard(
    panel: string,
    targetGroupId: string,
    userId: string,
    notice?: string,
    page = 1,
    mode: "allow" | "deny" = "allow",
  ): CardResult {
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);
    if (!canManage) {
      const card = renderCard({
        title: "权限不足",
        lines: ["修改规则需要群管理员或以上权限。"],
        rows: [[viewButton("back", "返回规则", "rules", "view", targetGroupId)]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const normalized = normalizeRulePanel(panel);
    switch (normalized) {
      case "keyword":
        return this.rulesKeywordPanel(targetGroupId, userId, page, notice);
      case "roster":
        return this.rulesRosterPanel(targetGroupId, userId, mode, page, notice);
      case "toggle":
        return this.rulesTogglePanel(targetGroupId, userId, notice);
      case "decision":
        return this.rulesDecisionPanel(targetGroupId, userId, notice, normalized);
      case "punish":
        return this.rulesPunishPanel(targetGroupId, userId, notice);
      case "more":
        return this.rulesMorePanel(targetGroupId, userId, notice);
    }
  }

  /** 子卡：开关设置（一行 2 个，标签显示当前状态）。 */
  private rulesTogglePanel(
    targetGroupId: string,
    userId: string,
    notice?: string,
  ): CardResult {
    const config = this.configStore.get(targetGroupId);
    const overridden = this.configStore.overriddenFields(targetGroupId);
    const fields: Array<RuleToggleSpec> = [
      { field: "wordFilterEnabled", label: "过滤", panel: "toggle", value: config.wordFilterEnabled },
      { field: "keywordRecall", label: "撤回", panel: "toggle", value: config.keywordRecall },
      { field: "joinAuditEnabled", label: "入群审核", panel: "toggle", value: config.joinAuditEnabled },
      { field: "exportEnabled", label: "导出", panel: "toggle", value: config.exportEnabled },
    ];
    return this.rulesBoolPanel({
      title: "群规则 · 开关设置",
      targetGroupId,
      userId,
      panel: "toggle",
      notice,
      fields,
      overridden,
    });
  }

  /** 子卡：入群审核（5 个决策枚举 + 要求班级/姓名，`●` 标当前值）。 */
  private rulesDecisionPanel(
    targetGroupId: string,
    userId: string,
    notice: string | undefined,
    panel: string,
  ): CardResult {
    const config = this.configStore.get(targetGroupId);
    const rows: CardButton[][] = [];
    rows.push([
      ruleChoiceButton(
        "decision-manual",
        "人工",
        targetGroupId,
        "joinDecision",
        "manual",
        config.joinDecision === "manual",
        panel,
      ),
      ruleChoiceButton(
        "decision-match",
        "命中通过",
        targetGroupId,
        "joinDecision",
        "approve_on_match",
        config.joinDecision === "approve_on_match",
        panel,
      ),
      ruleChoiceButton(
        "decision-reject",
        "命中拒绝",
        targetGroupId,
        "joinDecision",
        "reject_on_match",
        config.joinDecision === "reject_on_match",
        panel,
      ),
    ]);
    rows.push([
      ruleChoiceButton(
        "decision-auto",
        "全自动",
        targetGroupId,
        "joinDecision",
        "auto_approve",
        config.joinDecision === "auto_approve",
        panel,
      ),
      ruleChoiceButton(
        "decision-mismatch",
        "未命中拒绝",
        targetGroupId,
        "joinDecision",
        "reject_on_mismatch",
        config.joinDecision === "reject_on_mismatch",
        panel,
      ),
    ]);
    rows.push([
      ruleToggleButton(
        "requireClass",
        "要求班级",
        targetGroupId,
        "joinRequireClass",
        config.joinRequireClass,
        panel,
      ),
      ruleToggleButton(
        "requireName",
        "要求姓名",
        targetGroupId,
        "joinRequireName",
        config.joinRequireName,
        panel,
      ),
    ]);
    rows.push([
      this.ruleRestoreButton(panel, targetGroupId, ["joinDecision", "joinRequireClass", "joinRequireName"]),
      this.ruleBackButton(targetGroupId),
    ]);
    return this.rulePanelCard(
      "群规则 · 入群审核",
      targetGroupId,
      userId,
      notice,
      rows,
      [
        this.ruleInheritanceLine(targetGroupId, "joinDecision"),
        `**回答正则**：${config.joinAnswerPattern || "（未设置，用指令按钮设置）"}`,
      ],
    );
  }

  /** 子卡：违规处理（命中处罚 + 禁言时长快捷按钮）。 */
  private rulesPunishPanel(
    targetGroupId: string,
    userId: string,
    notice?: string,
  ): CardResult {
    const config = this.configStore.get(targetGroupId);
    const rows: CardButton[][] = [];
    rows.push([
      ruleChoiceButton("punish-none", "仅警告", targetGroupId, "keywordPunish", "none", config.keywordPunish === "none", "punish"),
      ruleChoiceButton("punish-mute", "禁言", targetGroupId, "keywordPunish", "mute", config.keywordPunish === "mute", "punish"),
    ]);
    rows.push([
      ruleChoiceButton("punish-kick", "移出", targetGroupId, "keywordPunish", "kick", config.keywordPunish === "kick", "punish"),
      ruleChoiceButton("punish-blacklist", "拉黑", targetGroupId, "keywordPunish", "kick_blacklist", config.keywordPunish === "kick_blacklist", "punish"),
    ]);
    rows.push([
      ruleChoiceButton("mute-60", "60秒", targetGroupId, "muteDurationSeconds", "60", config.muteDurationSeconds === 60, "punish"),
      ruleChoiceButton("mute-600", "600秒", targetGroupId, "muteDurationSeconds", "600", config.muteDurationSeconds === 600, "punish"),
      ruleChoiceButton("mute-3600", "1小时", targetGroupId, "muteDurationSeconds", "3600", config.muteDurationSeconds === 3600, "punish"),
    ]);
    rows.push([
      this.ruleRestoreButton("punish", targetGroupId, ["keywordPunish", "muteDurationSeconds"]),
      this.ruleBackButton(targetGroupId),
    ]);
    return this.rulePanelCard(
      "群规则 · 违规处理",
      targetGroupId,
      userId,
      notice,
      rows,
      [
        this.ruleInheritanceLine(targetGroupId, "keywordPunish"),
        `**禁言时长**：${config.muteDurationSeconds} 秒`,
      ],
    );
  }

  /** 子卡：关键词（分页逐条删除 + 加词 / 清空）。 */
  private rulesKeywordPanel(
    targetGroupId: string,
    userId: string,
    page: number,
    notice?: string,
  ): CardResult {
    const config = this.configStore.get(targetGroupId);
    const keywords = [...config.keywords];
    const pageSize = RULE_KEYWORD_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(keywords.length / pageSize));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = keywords.slice((current - 1) * pageSize, current * pageSize);

    const rows: CardButton[][] = [];
    for (const [index, keyword] of slice.entries()) {
      const serial = (current - 1) * pageSize + index;
      rows.push([
        viewButton(
          `del-${serial}`,
          ruleDeleteLabel(keyword),
          "rules",
          "delKeyword",
          targetGroupId,
          serial,
          current,
        ),
      ]);
    }
    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(
        viewButton("prev", "上一页", "rules", "panelPage", targetGroupId, "keyword", current - 1),
      );
    }
    if (current < pageCount) {
      paging.push(
        viewButton("next", "下一页", "rules", "panelPage", targetGroupId, "keyword", current + 1),
      );
    }
    // 第 4 行：加词 / 清空 / 翻页（每行总长 ≤12 字）
    rows.push([
      actionButton("add-keyword", "加词", "/rules add keyword "),
      ...paging,
      viewButtonWithOptions(
        "clear-keywords",
        "清空",
        encodeCallback("rules", "clearKeyword", targetGroupId),
        { modal: confirmRuleResetModal("本群关键词") },
      ),
    ]);
    rows.push([
      this.ruleRestoreButton("keyword", targetGroupId, ["keywords"], current),
      this.ruleBackButton(targetGroupId),
    ]);

    const body: string[] = [
      ...this.renderNotice(notice),
      `**关键词**：${keywords.length > 0 ? `${keywords.length} 条 · 第 ${current} / ${pageCount} 页` : "（未配置）"}`,
      ...(slice.length > 0
        ? slice.map((keyword, index) => `${(current - 1) * pageSize + index + 1}. ${keyword}`)
        : ["", "暂无关键词：点「加词」发送 `/rules add keyword <词>`，或手输 `/rules set keywords 广告,刷屏`。"]),
      "",
      this.ruleInheritanceLine(targetGroupId, "keywords"),
    ];
    const footer = [`本群：${this.displayGroup(targetGroupId)}`];
    if (current < pageCount) {
      footer.push(
        `还有 ${pageCount - current} 页，点「下一页」继续（关键词只支持卡片翻页）。`,
      );
    }
    return cardFromText("群规则 · 关键词", body.join("\n"), {
      rows,
      buttonHint: "每行一个关键词，点击即删除：",
      footer,
    });
  }

  /** 子卡：名单筛选（学院点选 + 年级点选，白/黑名单切换）。 */
  private rulesRosterPanel(
    targetGroupId: string,
    userId: string,
    mode: "allow" | "deny",
    page: number,
    notice?: string,
  ): CardResult {
    const config = this.configStore.get(targetGroupId);
    const colleges = this.activityRoster?.listColleges() ?? [];
    const pageSize = RULE_COLLEGE_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(colleges.length / pageSize));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = colleges.slice((current - 1) * pageSize, current * pageSize);
    const selected = new Set(
      mode === "allow" ? config.allowColleges : config.denyColleges,
    );

    // 5 行键盘上限：学院（≤4 行）+ 模式/翻页（1 行）+ 年级（1 行）+ 恢复/返回（1 行）
    const rows: CardButton[][] = [];
    for (const college of slice) {
      rows.push([
        ruleChoiceButton(
          `college-${college}`,
          college,
          targetGroupId,
          mode === "allow" ? "allowColleges" : "denyColleges",
          college,
          selected.has(college),
          "roster",
        ),
      ]);
    }
    if (slice.length === 0) {
      rows.push([
        actionButton(
          "college-manual",
          "手输学院",
          `/rules set ${mode === "allow" ? "allowColleges" : "denyColleges"} `,
        ),
      ]);
    }
    const modePaging: CardButton[] = [
      rosterModeButton("roster-allow", "白名单", targetGroupId, "allow", mode === "allow"),
      rosterModeButton("roster-deny", "黑名单", targetGroupId, "deny", mode === "deny"),
    ];
    if (current > 1) {
      modePaging.push(
        viewButton("prev", "上一页", "rules", "panelPage", targetGroupId, "roster", current - 1, mode),
      );
    }
    if (current < pageCount) {
      modePaging.push(
        viewButton("next", "下一页", "rules", "panelPage", targetGroupId, "roster", current + 1, mode),
      );
    }
    rows.push(modePaging);
    rows.push(
      PROFILE_ENTRY_YEARS.map((year) =>
        ruleChoiceButton(
          `year-${year}`,
          year,
          targetGroupId,
          mode === "allow" ? "allowYears" : "denyYears",
          year,
          (mode === "allow" ? config.allowYears : config.denyYears).includes(year),
          "roster",
        ),
      ),
    );
    rows.push([
      this.ruleRestoreButton(
        "roster",
        targetGroupId,
        ["allowColleges", "denyColleges", "allowYears", "denyYears"],
        current,
        mode,
      ),
      this.ruleBackButton(targetGroupId),
    ]);

    const collegeLine =
      config.allowColleges.length > 0
        ? `允许学院：${config.allowColleges.join("、")}`
        : config.denyColleges.length > 0
          ? `禁止学院：${config.denyColleges.join("、")}`
          : "学院：不限";
    const yearLine =
      config.allowYears.length > 0
        ? `允许年级：${config.allowYears.join("、")}`
        : config.denyYears.length > 0
          ? `禁止年级：${config.denyYears.join("、")}`
          : "年级：不限";
    return cardFromText(
      "群规则 · 名单筛选",
      [
        ...this.renderNotice(notice),
        `**当前模式**：${mode === "allow" ? "白名单（允许）" : "黑名单（禁止）"}`,
        `**学院**：${collegeLine} · 第 ${current} / ${pageCount} 页`,
        `**年级**：${yearLine}（点一下切换选中）`,
        "",
        this.ruleInheritanceLine(targetGroupId, "allowColleges"),
      ].join("\n"),
      {
        rows,
        buttonHint: "点击切换选中（● 为已选）：",
        footer: [
          `本群：${this.displayGroup(targetGroupId)}`,
          "学院来自班级库点选；班级库缺失时可用指令按钮手输。",
        ],
      },
    );
  }

  /** 子卡：更多设置（补齐所有尚未有按钮的字段）。 */
  private rulesMorePanel(
    targetGroupId: string,
    userId: string,
    notice?: string,
  ): CardResult {
    const config = this.configStore.get(targetGroupId);
    const rows: CardButton[][] = [
      [
        ruleToggleButton("enabled", "机器人", targetGroupId, "enabled", config.enabled, "more"),
        ruleToggleButton("autoApprove", "自动通过", targetGroupId, "autoApprove", config.autoApproveJoin, "more"),
      ],
      [
        ruleToggleButton("notifyAuto", "处理通知", targetGroupId, "notifyAutoApproved", config.notifyAutoApproved, "more"),
        ruleToggleButton("joinNotify", "审核意见", targetGroupId, "joinReviewOpinion", config.joinReviewOpinion, "more"),
      ],
      [
        actionButton("warning", "警告文案", "/rules set warning "),
        actionButton("keyword-manual", "关键词", "/rules set keywords "),
      ],
      [
        actionButton("mute-custom", "禁言时长", "/rules set muteDuration "),
        actionButton("answer-pattern", "回答正则", "/rules set joinAnswerPattern "),
      ],
      [
        this.ruleRestoreButton("more", targetGroupId, [
          "enabled",
          "autoApproveJoin",
          "notifyAutoApproved",
          "joinReviewOpinion",
          "warningMessage",
          "joinAnswerPattern",
        ]),
        this.ruleBackButton(targetGroupId),
      ],
    ];
    return this.rulePanelCard(
      "群规则 · 更多设置",
      targetGroupId,
      userId,
      notice,
      rows,
      [
        this.ruleInheritanceLine(targetGroupId, "enabled"),
        `**警告文案**：${config.warningMessage}`,
        `**禁言时长**：${config.muteDurationSeconds} 秒 · **回答正则**：${config.joinAnswerPattern || "（未设置）"}`,
        "要求班级 / 要求姓名在「入群审核」子卡；关键词在「关键词」子卡。",
      ],
    );
  }

  /** 通用布尔开关子卡：一行 2 个，正文逐条列出「字段：当前值（继承 / 本群覆盖）」。 */
  private rulesBoolPanel(input: {
    title: string;
    targetGroupId: string;
    userId: string;
    panel: string;
    notice?: string | undefined;
    fields: readonly RuleToggleSpec[];
    overridden: ReadonlySet<keyof GroupConfigOverride>;
  }): CardResult {
    const rows: CardButton[][] = [];
    for (let index = 0; index < input.fields.length; index += 2) {
      const pair = input.fields.slice(index, index + 2);
      rows.push(
        pair.map((spec) =>
          ruleToggleButton(
            spec.field,
            spec.label,
            input.targetGroupId,
            spec.field,
            spec.value,
            spec.panel,
          ),
        ),
      );
    }
    rows.push([
      this.ruleRestoreButton(
        input.panel,
        input.targetGroupId,
        input.fields.map((spec) => spec.field),
      ),
      this.ruleBackButton(input.targetGroupId),
    ]);
    const lines = input.fields.map(
      (spec) =>
        `${spec.label}：${spec.value ? "开" : "关"}（${
          input.overridden.has(spec.field) ? "本群覆盖" : "继承全局"
        }）`,
    );
    return this.rulePanelCard(
      input.title,
      input.targetGroupId,
      input.userId,
      input.notice,
      rows,
      lines,
    );
  }

  /** 规则子卡的统一外壳：正文行 + 权限已校验后的按钮。 */
  private rulePanelCard(
    title: string,
    targetGroupId: string,
    userId: string,
    notice: string | undefined,
    rows: CardButton[][],
    body: readonly string[],
  ): CardResult {
    void userId;
    const isGlobal = targetGroupId === DEFAULT_GROUP_ID;
    return cardFromText(
      isGlobal ? `${title}（全局）` : title,
      [
        ...(isGlobal ? ["**全局默认规则**：只影响未单独覆盖该字段的群。"] : []),
        ...this.renderNotice(notice),
        ...body,
      ].join("\n"),
      {
        rows,
        buttonHint: "点击即生效：",
        footer: [
          isGlobal ? "全局规则仅超管可改。" : `本群：${this.displayGroup(targetGroupId)}`,
        ],
      },
    );
  }

  /** 正文里的「字段：当前值（继承全局 / 本群覆盖）」。 */
  private ruleInheritanceLine(
    targetGroupId: string,
    field: keyof GroupConfigOverride,
  ): string {
    const overridden = this.configStore.overriddenFields(targetGroupId);
    return `**${ruleFieldLabel(field)}**：${
      overridden.has(field) ? "本群覆盖" : "继承全局"
    }`;
  }

  /** 「恢复本页继承」按钮（二次确认，调用 `clearFields`）。 */
  private ruleRestoreButton(
    panel: string,
    targetGroupId: string,
    fields: readonly (keyof GroupConfigOverride)[],
    page = 1,
    mode: "allow" | "deny" = "allow",
  ): CardButton {
    return viewButtonWithOptions(
      `reset-${panel}`,
      "恢复本页继承",
      encodeCallback(
        "rules",
        "resetPage",
        targetGroupId,
        panel,
        fields.join(","),
        page,
        mode,
      ),
      { modal: confirmRuleResetModal("本页字段") },
    );
  }

  private ruleBackButton(targetGroupId: string): CardButton {
    return viewButton("back", "返回规则", "rules", "view", targetGroupId);
  }

  /** 回调：规则开关/枚举切换（固定动作 → 自动执行并回刷新后的卡片）。 */
  public async toggleRulesCard(
    targetGroupId: string,
    field: string,
    value: string,
    userId: string,
    panel?: string,
    replyGroupId?: string,
    page = 1,
    mode: "allow" | "deny" = "allow",
  ): Promise<CardResult> {
    const result = await this.handleRulesSet(undefined, userId, [
      "rules",
      "set",
      targetGroupId,
      field,
      value,
    ]);
    const notice = `${this.mention(replyGroupId, userId)}已更新：${ruleFieldLabel(field)} = ${value}`;
    const targetPanel = normalizeRulePanel(panel);
    if (!result.ok) {
      const card = renderCard({
        title: "规则未修改",
        lines: [notice, "", ...result.text.split("\n")],
        rows: [
          [
            viewButton(
              "back",
              "返回规则",
              "rules",
              "panel",
              targetGroupId,
              targetPanel,
            ),
          ],
        ],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("rule updated via callback", {
      targetGroupId,
      field,
      value,
      userId,
    });
    if (!panel) {
      return this.rulesCard(undefined, userId, ["rules", targetGroupId], notice);
    }
    return this.rulesPanelCard(
      targetPanel,
      targetGroupId,
      userId,
      notice,
      page,
      mode,
    );
  }

  /**
   * 回调：关键词逐条删除（`cb:rules:delKeyword:<群>:<序号>:<页码>`）。
   *
   * 序号是**当前页内**的序号，删除后回到同一页（页尾自动收敛到上一页）。
   */
  public delKeywordCard(
    targetGroupId: string,
    serial: number,
    page: number,
    userId: string,
    replyGroupId?: string,
  ): CardResult {
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);
    if (!canManage) {
      return this.ruleDeniedCard(targetGroupId, "删除关键词需要群管理员或以上权限。");
    }
    const config = this.configStore.get(targetGroupId);
    const keywords = [...config.keywords];
    const index = serial;
    if (index < 0 || index >= keywords.length) {
      return this.ruleDeniedCard(targetGroupId, "该关键词已不存在，可能已被其它操作删除。");
    }
    const removed = keywords[index]!;
    keywords.splice(index, 1);
    this.configStore.setOverride({
      groupId: targetGroupId,
      keywords: keywords.length > 0 ? keywords : [],
    });
    log.info("rule keyword deleted via callback", {
      targetGroupId,
      removed,
      userId,
    });
    const nextPage = Math.min(
      Math.max(page, 1),
      Math.max(1, Math.ceil(keywords.length / RULE_KEYWORD_PAGE_SIZE)),
    );
    const notice = `${this.mention(replyGroupId, userId)}已删除关键词：${removed}`;
    return this.rulesKeywordPanel(targetGroupId, userId, nextPage, notice);
  }

  /** 回调：清空关键词（二次确认后走 setOverride，保留字段级覆盖语义）。 */
  public clearKeywordsCard(
    targetGroupId: string,
    userId: string,
    replyGroupId?: string,
  ): CardResult {
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);
    if (!canManage) {
      return this.ruleDeniedCard(targetGroupId, "清空关键词需要群管理员或以上权限。");
    }
    this.configStore.setOverride({ groupId: targetGroupId, keywords: [] });
    log.info("rule keywords cleared via callback", { targetGroupId, userId });
    return this.rulesKeywordPanel(
      targetGroupId,
      userId,
      1,
      `${this.mention(replyGroupId, userId)}已清空关键词。`,
    );
  }

  /**
   * 回调：恢复本页继承（`cb:rules:resetPage:<群>:<panel>:<字段列表>`）。
   *
   * 字段列表由按钮带过来，但仍会按面板白名单过滤，避免按钮伪造清掉别的字段。
   */
  public resetRulePageCard(
    targetGroupId: string,
    panel: string,
    rawFields: string,
    userId: string,
    replyGroupId?: string,
    page = 1,
    mode: "allow" | "deny" = "allow",
  ): CardResult {
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);
    if (!canManage) {
      return this.ruleDeniedCard(targetGroupId, "恢复继承需要群管理员或以上权限。");
    }
    const normalized = normalizeRulePanel(panel);
    const allowed = new Set<keyof GroupConfigOverride>(
      RULE_PANEL_FIELDS[normalized],
    );
    const fields = rawFields
      .split(",")
      .map((field) => field.trim())
      .filter((field): field is keyof GroupConfigOverride =>
        allowed.has(field as keyof GroupConfigOverride),
      );
    if (fields.length === 0) {
      return this.ruleDeniedCard(targetGroupId, "本页没有可恢复的字段。");
    }
    this.configStore.clearFields(targetGroupId, fields);
    log.info("rule page reset", { targetGroupId, panel: normalized, fields, userId });
    const notice = `${this.mention(replyGroupId, userId)}已恢复本页继承：${fields
      .map((field) => ruleFieldLabel(field))
      .join("、")}`;
    return this.rulesPanelCard(
      normalized,
      targetGroupId,
      userId,
      notice,
      page,
      mode,
    );
  }

  /**
   * 回调：恢复全部继承（`cb:rules:resetAll:<群>`）。
   *
   * 与「恢复本页继承」不同，这里清空该群的全部字段级覆盖，等价于旧 `removeOverride`。
   */
  public resetAllRulesCard(
    targetGroupId: string,
    userId: string,
    replyGroupId?: string,
  ): CardResult {
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);
    if (!canManage) {
      return this.ruleDeniedCard(targetGroupId, "恢复继承需要群管理员或以上权限。");
    }
    this.configStore.removeOverride(targetGroupId);
    log.info("rule overrides reset", { targetGroupId, userId });
    return this.rulesCard(undefined, userId, ["rules", targetGroupId], `${this.mention(replyGroupId, userId)}已恢复全部继承。`);
  }

  /**
   * 回调：学院 / 年级点选（`cb:rules:rosterToggle:<群>:<字段>:<模式>:<取值>`）。
   *
   * `field` 必须是名单类字段；取值按当前列表切换（有则删、无则加）。
   */
  public rosterToggleCard(
    targetGroupId: string,
    field: string,
    mode: "allow" | "deny",
    option: string,
    userId: string,
    replyGroupId?: string,
    page = 1,
  ): CardResult {
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);
    if (!canManage) {
      return this.ruleDeniedCard(targetGroupId, "修改名单需要群管理员或以上权限。");
    }
    if (!isRosterField(field)) {
      return this.ruleDeniedCard(targetGroupId, "未知的名单字段。");
    }
    const cleaned = option.trim();
    if (cleaned.length === 0) {
      return this.ruleDeniedCard(targetGroupId, "没有识别到要切换的取值。");
    }
    const config = this.configStore.get(targetGroupId);
    const current = new Set<string>(config[field]);
    if (current.has(cleaned)) {
      current.delete(cleaned);
    } else {
      current.add(cleaned);
    }
    const next = [...current].sort();
    this.configStore.setOverride({
      groupId: targetGroupId,
      [field]: next,
    } as GroupConfigOverride);
    log.info("rule roster toggled via callback", {
      targetGroupId,
      field,
      option: cleaned,
      userId,
    });
    const action = current.has(cleaned) ? "已选中" : "已取消";
    const notice = `${this.mention(replyGroupId, userId)}${action}：${cleaned}`;
    return this.rulesPanelCard(
      "roster",
      targetGroupId,
      userId,
      notice,
      page,
      mode,
    );
  }

  /** 权限不足 / 目标非法时的统一子卡提示（可返回规则概览）。 */
  private ruleDeniedCard(
    targetGroupId: string,
    reason: string,
  ): CardResult {
    const card = renderCard({
      title: "权限不足",
      lines: [reason],
      rows: [
        [viewButton("back", "返回规则", "rules", "view", targetGroupId)],
      ],
    });
    return { ok: false, text: card.text, rich: card };
  }

  /**
   * `/rules all`：全局默认规则卡（仅超级管理员）。
   *
   * 与群规则**同一套子卡结构**，目标 `DEFAULT_GROUP_ID`；正文标明「只影响未覆盖的群」，
   * 底部是「覆盖率总览」（列出 `listOverrideSummaries()`）+ 刷新 + 规则帮助。
   */
  private globalRulesCard(userId: string, page = 1): CardResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      const card = renderCard({
        title: "权限不足",
        lines: [GLOBAL_RULES_DENIED],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const rows: CardButton[][] = [
      [
        viewButton("panel-toggle", "开关设置", "rules", "panel", DEFAULT_GROUP_ID, "toggle"),
        viewButton("panel-decision", "入群审核", "rules", "panel", DEFAULT_GROUP_ID, "decision"),
        viewButton("panel-punish", "违规处理", "rules", "panel", DEFAULT_GROUP_ID, "punish"),
      ],
      [
        viewButton("panel-keywords", "关键词", "rules", "panel", DEFAULT_GROUP_ID, "keyword"),
        viewButton("panel-roster", "名单筛选", "rules", "panel", DEFAULT_GROUP_ID, "roster"),
        viewButton("panel-more", "更多设置", "rules", "panel", DEFAULT_GROUP_ID, "more"),
      ],
      [
        viewButton("overrides", "覆盖率总览", "rules", "overrides", "1"),
        viewButton("refresh", "刷新", "rules", "all"),
        viewButton("help", "规则帮助", "help", "topic", "rules"),
      ],
    ];
    return cardFromText("全局规则（默认）", this.formatGlobalRules(), {
      rows,
      buttonHint: "点击即生效：",
      footer: [
        "只影响未单独覆盖该字段的群；单个群可用「恢复本页继承」回落到这里。",
        "手输：/rules set all <字段> <值>",
      ],
    });
  }

  /**
   * 回调：全局规则覆盖率总览（`cb:rules:overrides:<页>`）。
   *
   * 每页 10 个群，列出该群显式覆盖的字段；没有覆盖的显示「全部继承全局」。
   */
  public ruleOverridesCard(userId: string, page = 1): CardResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      const card = renderCard({
        title: "权限不足",
        lines: [GLOBAL_RULES_DENIED],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const summaries = this.configStore.listOverrideSummaries();
    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(summaries.length / pageSize));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = summaries.slice((current - 1) * pageSize, current * pageSize);
    const lines: string[] = [
      "全局默认规则只影响**未覆盖**的群；下面是各群的字段级覆盖情况。",
      `共 ${summaries.length} 个群有覆盖 · 第 ${current} / ${pageCount} 页`,
      "",
    ];
    if (slice.length === 0) {
      lines.push("目前没有任何群覆盖全局规则（全部继承全局）。");
    }
    for (const summary of slice) {
      lines.push(
        `**${this.displayGroup(summary.groupId)}**：${summary.fields.length} 个字段（${summary.fields
          .map((field) => ruleFieldShortLabel(field))
          .join("、")}）`,
      );
    }
    const rows: CardButton[][] = [];
    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(viewButton("prev", "上一页", "rules", "overrides", current - 1));
    }
    if (current < pageCount) {
      paging.push(viewButton("next", "下一页", "rules", "overrides", current + 1));
    }
    rows.push(
      paging.length > 0
        ? paging
        : [viewButton("overrides", "刷新总览", "rules", "overrides", current)],
    );
    rows.push([
      viewButton("back-global", "返回全局规则", "rules", "all"),
      viewButton("help", "规则帮助", "help", "topic", "rules"),
    ]);
    const footer = [`全局：${this.formatGlobalRules().split("\n")[0] ?? ""}`];
    if (current < pageCount) {
      footer.push(`下一页：/rules overrides +${current + 1}`);
    }
    return cardFromText("规则覆盖率总览", lines.join("\n"), {
      rows,
      footer,
    });
  }

  /**
   * `/testmenu [页码]`：官方回调按钮翻页试验（仅全局超级管理员）。
   *
   * 卡片里的「上一页 / 下一页 / 返回」是回调按钮（`action.type=1`），
   * 点击后由 `TestMenuService` 走互动事件链路被动回复新的一页；
   * 同时保留 `/testmenu <页码>` 指令入口与「指令翻页」按钮作为双通道兜底。
   */
  private handleTestMenu(
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return {
        ok: false,
        text: "权限不足：/testmenu 需要全局超级管理员权限。",
      };
    }
    const raw = parts[1];
    let page = 1;
    if (raw !== undefined) {
      const parsed = Number.parseInt(raw, 10);
      if (
        Number.isNaN(parsed) ||
        parsed < 1 ||
        parsed > TEST_MENU_PAGE_COUNT
      ) {
        return {
          ok: false,
          text: `页码范围 1-${TEST_MENU_PAGE_COUNT}，例如 /testmenu 2`,
        };
      }
      page = parsed;
    }
    const card = buildTestMenuCard(page);
    return { ok: true, text: card.text, rich: card };
  }

  /**
   * `/testat [all]`：真机自检「群里 @ 到底怎么发才生效」（仅全局超级管理员）。
   *
   * 已实测（本机真机）：**Markdown 卡片里的 `<@!openid>` 生效**，纯文本 `content` 里的
   * `<@!openid>` 与 `@everyone` 都不生效 —— 与官方内嵌格式文档的暗示相反。所以：
   *
   * 1. 纯文本 `content` + `<@!我>`（实测无效，保留作对照）；
   * 2. Markdown 卡片，首行 `<@!我>`（实测有效）；
   * 3. Markdown 卡片，正文中间的 `<@!我>`（实测有效）；
   * 4. 仅 `/testat all`：一组 @全体候选写法（markdown 里的 `@everyone` / `<@!all>` /
   *    `<@!everyone>` / `@全体成员`，以及纯文本 `<@!all>`），找出哪个（如果有）真能 @ 全群。
   *
   * 最后回一张汇总卡，请操作者回答哪几条真的 @ 到了，据此决定活动发布的 @全体实现方式。
   */
  private async handleTestAt(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：/testat 需要全局超级管理员权限。" };
    }
    const sender = this.richMessages;
    if (!sender) {
      return { ok: false, text: "发送通道未启用，无法自检。" };
    }
    if (!groupId) {
      return {
        ok: false,
        text:
          "请在群里执行 /testat（要验证的是群消息里的 @ 渲染）。\n" +
          "额外验证 @全体成员候选写法：/testat all（会真的打扰全群，请谨慎）。",
      };
    }
    const wantAll = normalize(parts[1]) === "all" || parts[1] === "全体";
    const mention = `<@!${userId}>`;
    const lines: string[] = [];
    const failures: string[] = [];

    const record = async (
      label: string,
      result: { ok: boolean; detail: string; mode: string },
    ): Promise<void> => {
      lines.push(
        `${label}：${result.ok ? `已发送（${result.mode}）` : `失败（${result.detail}）`}`,
      );
      if (!result.ok) {
        failures.push(label);
      }
    };

    const first = await sender.sendPlainToGroup(
      groupId,
      `【@测试 1】纯文本 content + 提及：${mention} 这条走 msg_type=0。`,
    );
    await record("1. 纯文本 `content` + `<@!我>`（已知无效，对照）", first);

    const cardFirst = await sender.sendToGroup(groupId, {
      markdown: `${mention}\n\n【@测试 2】这是 Markdown 卡片，**提及放在第一行**。`,
      text: `【@测试 2】Markdown 卡片，提及放在第一行：${mention}`,
    });
    await record("2. Markdown 卡片（首行 @，已知有效）", cardFirst);

    const cardMiddle = await sender.sendToGroup(groupId, {
      markdown: `【@测试 3】这是 Markdown 卡片，提及放在**正文中间**：${mention} 后面还有字。`,
      text: `【@测试 3】Markdown 卡片，提及在正文中间：${mention}`,
    });
    await record("3. Markdown 卡片（正文中间 @，已知有效）", cardMiddle);

    if (wantAll) {
      let index = 4;
      for (const probe of AT_ALL_PROBES) {
        const result =
          probe.kind === "card"
            ? await sender.sendToGroup(groupId, {
                markdown: probe.content,
                text: stripMarkdownForText(probe.content),
              })
            : await sender.sendPlainToGroup(groupId, probe.content);
        await record(`${index}. ${probe.label}`, result);
        index += 1;
      }
    }
    const sent = lines.length;

    const card = renderCard({
      title: "@ 测试结果",
      lines: [
        `已在群里发送 ${sent} 条测试消息（本条是汇总）：`,
        ...lines,
        "",
        "**请回复：哪几条真的 @ 到了你 / 全体员工？**",
        "判断标准：昵称/「全体成员」被高亮、收到 @ 提醒、手机收到通知。",
        wantAll
          ? "上面 4 起的几条是 @全体候选写法，只要有一条真的提醒了全群，就告诉我它的编号。"
          : "想继续找能真正 @ 全群的写法：点下面按钮（会再次打扰全群）。",
        failures.length > 0
          ? `发送失败的条目：${failures.join("、")}`
          : "",
        "",
        `操作人：${this.displayUser(userId)}`,
      ].filter((line) => line.length > 0),
      rows: [
        [
          actionButton("again", "再测一次", "/testat"),
          actionButton("all", "@全体候选", "/testat all", {
            style: 3,
            modal: {
              content: "会向全群发多条 @全体候选消息，确认发送？",
              confirmText: "发送",
              cancelText: "取消",
            },
          }),
        ],
      ],
      footer: ["测完请把有效的编号告诉开发者，据此实现活动发布的 @全体。"],
    });
    return { ok: true, text: card.text, rich: card };
  }

  /** `/menu [系统|管理|超管|活动|审核|运营]`：渲染对应层级的交互菜单。 */
  private handleMenu(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const query = parts[1];
    const section = findMenuSection(query);
    if (query !== undefined && section === undefined) {
      const main = this.mainMenu(groupId, userId);
      return {
        ok: false,
        text:
          `未找到「${query}」菜单。\n` +
          "用法：/menu [系统|管理|超管|活动|审核|运营]\n\n" +
          main.text,
        rich: main,
      };
    }
    const view = buildMenu(
      section ?? "main",
      this.menuContext(groupId, userId),
    );
    return { ok: view.ok, text: view.message.text, rich: view.message };
  }

  /** 未知指令：保留原来的报错文案，同时附上菜单入口按钮。 */
  private unknownCommandResult(
    groupId: string | undefined,
    userId: string,
    command: string | undefined,
  ): CommandResult {
    const rich = buildUnknownCommandMenu(
      command ?? "",
      this.menuContext(groupId, userId),
    );
    return { ok: false, text: rich.text, rich };
  }

  private menuContext(groupId: string | undefined, userId: string): MenuContext {
    const context: MenuContext = {
      userId,
      groupId,
      // 与 buildHelp 保持一致：未注入身份映射时（单元测试）视为已绑定
      bound: this.identityMap ? Boolean(this.identityMap.getQq(userId)) : true,
      permissions: this.permissions,
    };
    if (this.display) {
      context.userLabel = this.display.user(userId);
    }
    if (groupId !== undefined) {
      if (this.display) {
        context.groupLabel = this.display.group(groupId);
      }
      if (this.identityMap) {
        context.groupBound = Boolean(this.identityMap.getGroupNumber(groupId));
      }
    }
    return context;
  }

  private handleHelp(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    return this.helpCard(groupId, userId, parts[1]);
  }

  private renderHelpTopic(
    topic: HelpTopic,
    context: Parameters<HelpTopic["body"]>[0],
  ): string {
    return [
      `/${topic.name} — ${topic.title}`,
      `所需权限：${topic.requirement}`,
      "",
      ...topic.body(context),
      "",
      "相关：/help 查看全部可用指令",
    ].join("\n");
  }

  private buildHelp(groupId: string | undefined, userId: string): string {
    const lines: string[] = [
      "可用指令：",
      "/help - 显示帮助",
      "/help <指令> - 查看某个指令的详细用法，例如 /help rules、/help bind、/help perm",
      "/menu - 打开系统菜单（系统 / 管理 / 超管），按钮点击即执行",
      "/bind qq <QQ号> - 绑定自己的 QQ 号",
    ];
    const isSuper = this.permissions.isSuperAdmin(userId);
    const canBindGroup =
      groupId !== undefined &&
      (isSuper || this.permissions.canApproveJoin(userId, groupId));
    if (canBindGroup) {
      lines.push("/bind group <群号> - 绑定当前群号");
    }
    if (isSuper) {
      lines.push("/bind user <userId> <QQ号> - 绑定任意用户");
      lines.push("/bind groupid <group_openid> <群号> - 绑定任意群");
      lines.push("/whois <QQ号|userId|群号|group_openid> - 查询映射");
      lines.push(
        `/testmenu [页码] - 回调按钮翻页试验（1-${TEST_MENU_PAGE_COUNT} 页）`,
      );
    }

    const isBound = this.identityMap
      ? Boolean(this.identityMap.getQq(userId))
      : true;
    if (!isBound) {
      lines.push("", "请先绑定 QQ 号：/bind qq <QQ号>");
      lines.push("绑定后使用 /help 查看可用指令。");
      return lines.join("\n");
    }

    const groupBound = groupId !== undefined
      ? Boolean(this.identityMap?.getGroupNumber(groupId))
      : true;
    if (groupId !== undefined && !groupBound) {
      lines.push("", "本群未绑定，群管理指令不可用。");
      lines.push(
        canBindGroup
          ? "请先绑定本群：/bind group <群号>"
          : "请联系群管理员绑定本群：/bind group <群号>",
      );
      return lines.join("\n");
    }

    lines.push("/myperm - 查看自己的权限");
    lines.push("/profile - 配置个人资料（班级/学院/姓名/学号）");
    lines.push("/activity - 活动列表；/activity join <#活动短码> 报名");
    const canModerate =
      groupId !== undefined
        ? this.permissions.canReviewContent(userId, groupId)
        : this.permissions.hasAnyGroupRole(userId, PermissionLevel.Moderator);
    const canAdmin =
      groupId !== undefined
        ? this.permissions.canApproveJoin(userId, groupId)
        : this.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin);

    if (canModerate) {
      lines.push("/pending [#群短码|群号] - 查看待审批入群申请");
      lines.push("/sync [#群短码|群号] - 从官方接口同步待审批申请");
      lines.push("/rules [#群短码|群号] - 查看群规则配置");
      lines.push("/audit [#群短码|群号] [数量] - 查看最近审计记录");
      lines.push("/status [#群短码|群号] - 查看群运行状态");
      lines.push("/test - 测试机器人是否正常响应");
    }
    if (canAdmin) {
      lines.push("/approve [#群短码|群号] <申请ID> - 通过入群申请");
      lines.push("/reject [#群短码|群号] <申请ID> [原因] - 拒绝入群申请");
      lines.push("/notify - 配置入群申请推送（卡片 + 快捷同意/拒绝按钮）");
      lines.push("/rules set <字段> <值> - 修改群规则（关键词、警告文案等）");
    }
    if (isSuper) {
      lines.push("/perm list [#群短码|群号] - 查看权限配置");
      lines.push("/perm grant super <userId|QQ号> - 授予全局超管");
      lines.push("/perm revoke super <userId|QQ号> - 撤销全局超管");
      lines.push("/perm grant gsuper [#群短码|群号] <userId|QQ号> - 授予本群超管");
      lines.push("/perm revoke gsuper [#群短码|群号] <userId|QQ号> - 撤销本群超管");
      lines.push("/perm grant admin [#群短码|群号] <userId|QQ号> - 授予群管理员");
      lines.push("/perm revoke admin [#群短码|群号] <userId|QQ号> - 撤销群管理员");
      lines.push("/perm grant mod [#群短码|群号] <userId|QQ号> - 授予审核员");
      lines.push("/perm revoke mod [#群短码|群号] <userId|QQ号> - 撤销审核员");
      lines.push("/rules all - 查看全局默认规则");
      lines.push("/rules set all <字段> <值> - 修改全局默认规则");
    }
    if (!canModerate && !canAdmin && !isSuper) {
      lines.push("当前没有更多可执行的管理指令。");
    }
    return lines.join("\n");
  }

  private handleMyPermission(
    groupId: string | undefined,
    userId: string,
  ): CommandResult {
    const level = this.permissions.levelFor(userId, groupId);
    return {
      ok: true,
      text: [
        `你的权限等级：${level}`,
        `全局超级管理员：${this.permissions.isSuperAdmin(userId)}`,
        groupId
          ? `本群超级管理员：${this.permissions.isGroupSuperAdmin(userId, groupId)}`
          : undefined,
        groupId ? `当前群：${this.displayGroup(groupId)}` : "当前会话：私聊",
        `审核入群：${this.permissions.canApproveJoin(userId, groupId ?? "")}`,
        `管理规则：${this.permissions.canManageRules(userId, groupId ?? "")}`,
        `内容审核：${this.permissions.canReviewContent(userId, groupId ?? "")}`,
        `导出数据：${this.permissions.canExportData(userId, groupId ?? "")}`,
        `配置权限：${this.permissions.isSuperAdmin(userId)}`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    };
  }

  private handlePermissionConfig(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      log.warn("permission config denied", { groupId, userId });
      return { ok: false, text: "权限不足：仅超级管理员可以配置权限。" };
    }

    const action = normalize(parts[1]);
    if (!action || action === "list" || action === "列表") {
      const targetGroupId = this.resolveTargetGroupId(groupId, parts[2]);
      return {
        ok: true,
        text: this.formatPermissionList(targetGroupId),
      };
    }

    const role = normalize(parts[2]);
    const isSuperRole = role === "super" || role === "超管";
    const isGroupSuperRole = GROUP_SUPER_ROLES.has(role);
    let targetGroupId: string | undefined;
    let targetUserId: string | undefined;

    if (isSuperRole) {
      targetUserId = this.resolveUserId(parts[3]);
    } else if (isGroupSuperRole) {
      targetGroupId = groupId ?? this.resolveTargetGroupId(undefined, parts[3]);
      targetUserId = this.resolveUserId(groupId ? parts[3] : parts[4]);
    } else {
      targetGroupId = this.resolveTargetGroupId(groupId, parts[3]);
      targetUserId = this.resolveUserId(groupId ? parts[3] : parts[4]);
    }

    if (!role) {
      return { ok: false, text: PERM_USAGE };
    }

    if (!isSuperRole && !targetGroupId) {
      return {
        ok: false,
        text: "私信中配置群角色需要提供群号或 #群短码。",
      };
    }

    if (!targetUserId) {
      return { ok: false, text: PERM_USAGE };
    }

    try {
      if (action === "grant" || action === "授予") {
        this.grantRole(targetGroupId, role, targetUserId);
      } else if (action === "revoke" || action === "撤销") {
        this.revokeRole(targetGroupId, role, targetUserId);
      } else {
        return { ok: false, text: PERM_USAGE };
      }
    } catch (error) {
      log.warn("permission config failed", {
        groupId,
        userId,
        action,
        role,
        targetUserId,
        error: String(error),
      });
      return { ok: false, text: `权限配置失败：${String(error)}` };
    }

    log.info("permission config updated", {
      groupId: targetGroupId,
      userId,
      action,
      role,
      targetUserId,
    });
    return {
      ok: true,
      text: `已更新权限：${role} ${this.displayUser(targetUserId)}\n\n${this.formatPermissionList(targetGroupId)}`,
    };
  }

  private formatPermissionList(groupId?: string): string {
    const lines = [`全局超级管理员：${this.displayUsers(this.permissions.listSuperAdmins())}`];
    if (groupId) {
      const label = this.displayGroup(groupId);
      lines.push(
        `本群超级管理员（${label}）：${this.displayUsers(this.permissions.listGroupSuperAdmins(groupId))}`,
      );
      lines.push(
        `群管理员（${label}）：${this.displayUsers(this.permissions.listGroupAdmins(groupId))}`,
      );
      lines.push(
        `审核员（${label}）：${this.displayUsers(this.permissions.listModerators(groupId))}`,
      );
    } else {
      lines.push("本群超级管理员：私信中请指定 group_openid");
      lines.push("群管理员：私信中请指定 group_openid");
      lines.push("审核员：私信中请指定 group_openid");
    }
    return lines.join("\n");
  }

  private grantRole(
    groupId: string | undefined,
    role: string,
    targetUserId: string,
  ): void {
    if (role === "super" || role === "超管") {
      this.permissions.grantSuperAdmin(targetUserId);
      return;
    }
    if (!groupId) {
      throw new Error("group_openid is required");
    }
    if (GROUP_SUPER_ROLES.has(role)) {
      this.permissions.grantGroupSuperAdmin(groupId, targetUserId);
      return;
    }
    if (role === "admin" || role === "管理员") {
      this.permissions.grantGroupAdmin(groupId, targetUserId);
      return;
    }
    if (role === "mod" || role === "审核员") {
      this.permissions.grantModerator(groupId, targetUserId);
      return;
    }
    throw new Error(`未知角色：${role}`);
  }

  private revokeRole(
    groupId: string | undefined,
    role: string,
    targetUserId: string,
  ): void {
    if (role === "super" || role === "超管") {
      this.permissions.revokeSuperAdmin(targetUserId);
      return;
    }
    if (!groupId) {
      throw new Error("group_openid is required");
    }
    if (GROUP_SUPER_ROLES.has(role)) {
      this.permissions.revokeGroupSuperAdmin(groupId, targetUserId);
      return;
    }
    if (role === "admin" || role === "管理员") {
      this.permissions.revokeGroupAdmin(groupId, targetUserId);
      return;
    }
    if (role === "mod" || role === "审核员") {
      this.permissions.revokeModerator(groupId, targetUserId);
      return;
    }
    throw new Error(`未知角色：${role}`);
  }

  private async handleSync(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "同步官方申请",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/sync [#群短码|群号]",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    return this.syncCard(targetGroupId, userId, groupId);
  }

  /**
   * `/notify`：审核员自助配置入群申请推送。
   *
   * 订阅范围只有两种：`__all__`（我担任群管理员的全部群）与单个群；
   * 推送时还会再按「当前群是否有审批权限」过滤一次，越权订阅不会泄漏申请内容。
   */
  private async handleNotify(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    if (!this.notifications) {
      return { ok: false, text: "推送服务未启用。" };
    }
    const arg1 = normalize(parts[1]);
    if (!arg1) {
      return this.notifyCard(groupId, userId);
    }
    if (arg1 === "test" || arg1 === "测试") {
      return this.notifyTestCard(groupId, userId, groupId);
    }
    if (isToggleValue(arg1)) {
      // 群内：订阅本群；私信：订阅全部群
      const scope = groupId ?? NOTIFY_SCOPE_ALL;
      return this.notifyToggleCard(scope, isToggleOn(arg1), userId, groupId);
    }
    if (isAllScope(arg1)) {
      const action = normalize(parts[2]);
      if (!isToggleValue(action)) {
        return this.notifyCard(groupId, userId, NOTIFY_USAGE);
      }
      return this.notifyToggleCard(NOTIFY_SCOPE_ALL, isToggleOn(action), userId, groupId);
    }
    const targetGroupId = this.resolveTargetGroupId(undefined, parts[1]);
    const action = normalize(parts[2]);
    if (!targetGroupId || !isToggleValue(action)) {
      return this.notifyCard(groupId, userId, NOTIFY_USAGE);
    }
    return this.notifyToggleCard(targetGroupId, isToggleOn(action), userId, groupId);
  }

  private applyNotify(
    userId: string,
    scope: string,
    enabled: boolean,
  ): CommandResult {
    const label =
      scope === NOTIFY_SCOPE_ALL
        ? "全部群（你担任群管理员的群）"
        : `群 ${this.groupLabel(scope)}`;
    if (!enabled) {
      const removed = this.notifications?.unsubscribe(userId, scope) ?? false;
      return {
        ok: true,
        text: removed
          ? `已关闭：${label} 的入群申请推送。`
          : `${label} 的推送本来就是关闭的。`,
      };
    }
    const allowed =
      scope === NOTIFY_SCOPE_ALL
        ? this.permissions.isSuperAdmin(userId) ||
          this.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin)
        : this.permissions.canApproveJoin(userId, scope);
    if (!allowed) {
      return { ok: false, text: NOTIFY_PERMISSION_DENIED };
    }
    this.notifications?.subscribe(userId, scope);
    return {
      ok: true,
      text:
        `已开启：${label} 的入群申请推送。\n` +
        "有新的待审批申请时会私聊推送卡片，可直接点「同意 / 拒绝」按钮。",
    };
  }

  private renderNotifyStatus(
    userId: string,
    groupId: string | undefined,
  ): string {
    const scopes = this.notifications?.listScopes(userId) ?? [];
    const lines = [
      "入群申请推送：",
      `  全部群（你担任群管理员的群）：${
        scopes.includes(NOTIFY_SCOPE_ALL) ? "已开启" : "未开启"
      }`,
    ];
    for (const scope of scopes.filter((item) => item !== NOTIFY_SCOPE_ALL)) {
      lines.push(`  群 ${this.groupLabel(scope)}：已开启`);
    }
    const reviewable = this.permissions.listReviewableGroups(userId);
    lines.push(
      "",
      reviewable.length > 0
        ? `可审批的群：${reviewable.map((id) => this.groupLabel(id)).join("、")}`
        : "可审批的群：无（入群审批需要群管理员或以上权限）",
    );
    if (this.permissions.isSuperAdmin(userId)) {
      lines.push("说明：你是全局超级管理员，可审批所有群。");
    }
    if (groupId) {
      lines.push(`当前群：${this.groupLabel(groupId)}`);
    }
    lines.push("", NOTIFY_USAGE);
    return lines.join("\n");
  }

  private groupLabel(groupId: string): string {
    return this.displayGroup(groupId);
  }

  /**
   * 展示用户：QQ号 或随机短码 `#XXXXXX`。
   *
   * 没有注入 DisplayNameService 时（部分单测）回退为「绑定 QQ号 → QQ号，否则原样 id」。
   */
  private displayUser(officialId: string): string {
    if (this.display) {
      return this.display.user(officialId);
    }
    return this.identityMap?.getQq(officialId) ?? officialId;
  }

  /** 展示群：群号 或随机短码 `#XXXXXX`。 */
  private displayGroup(groupId: string): string {
    if (this.display) {
      return this.display.group(groupId);
    }
    return this.identityMap?.getGroupNumber(groupId) ?? groupId;
  }

  /** 展示申请：短码 `#XXXXXX`（替代又长又难读的 join_request_id）。 */
  private displayRequest(requestId: string): string {
    return this.display?.request(requestId) ?? requestId;
  }

  private displayUsers(ids: readonly string[]): string {
    return formatList(ids.map((id) => this.displayUser(id)));
  }

  /** 同步补齐的申请也推送一次；投递表保证同一申请不会重复推给同一个人。 */
  private async notifyPending(
    groupId: string,
    requests: readonly JoinRequest[],
  ): Promise<void> {
    if (!this.notifications) {
      return;
    }
    for (const request of requests) {
      await this.notifications
        .notifyJoinRequest({
          groupId,
          requestId: request.requestId,
          userId: request.userId,
          reason: request.reason,
        })
        .catch((error: unknown) => {
          log.warn("notify pending join request failed", {
            groupId,
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  // ------------------------------------------------------------- /profile

  private handleProfile(userId: string, parts: readonly string[]): CommandResult {
    const profiles = this.userProfiles;
    if (!profiles) {
      return { ok: false, text: "个人资料服务未启用。" };
    }
    const action = normalize(parts[1]);
    if (!action) {
      return { ok: true, text: this.formatProfile(userId) };
    }
    if (action === "set" || action === "设置") {
      const field = PROFILE_FIELD_ALIASES[normalize(parts[2])];
      if (!field) {
        return this.updateProfileSmart(userId, parts.slice(2).join(" "));
      }
      const value = parts.slice(3).join(" ").trim();
      if (value.length === 0) {
        return { ok: false, text: PROFILE_USAGE };
      }
      if (CLEAR_WORDS.has(value.toLowerCase())) {
        profiles.clear(userId, field);
        return {
          ok: true,
          text: `已清除：${PROFILE_FIELD_LABELS[field]}\n\n${this.formatProfile(userId)}`,
        };
      }
      try {
        profiles.set(userId, field, value);
      } catch (error) {
        return { ok: false, text: `设置失败：${formatError(error)}` };
      }
      return {
        ok: true,
        text: `已更新：${PROFILE_FIELD_LABELS[field]}\n\n${this.formatProfile(userId)}`,
      };
    }
    if (action === "clear" || action === "清除" || action === "重置") {
      profiles.clear(userId);
      return { ok: true, text: "已清空个人资料。" };
    }
    return { ok: false, text: PROFILE_USAGE };
  }

  /**
   * 智能 `/profile set`：一次给班级/姓名/学号，顺序与分隔符随意。
   * 有歧义或残留时整体不写入，只回报识别结果，让用户改用 `字段=值`。
   */
  private updateProfileSmart(userId: string, raw: string): CommandResult {
    const profiles = this.userProfiles;
    if (!profiles) {
      return { ok: false, text: "个人资料服务未启用。" };
    }
    const parsed = parseProfileInput(raw, {
      roster: profiles.rosterRef,
      aliases: this.classAliases,
    });
    if (parsed.error) {
      return {
        ok: false,
        text: `${parsed.error}\n\n${formatParseNotes(parsed)}\n\n${PROFILE_USAGE}`,
      };
    }
    if (parsed.fields.name === undefined
      && parsed.fields.studentId === undefined
      && parsed.fields.className === undefined
      && parsed.fields.college === undefined
      && parsed.fields.year === undefined) {
      return { ok: false, text: PROFILE_USAGE };
    }
    // 先整体校验再写入，避免"写一半失败"。
    try {
      if (parsed.fields.studentId !== undefined) {
        yearFromStudentId(parsed.fields.studentId);
      }
      if (parsed.fields.className !== undefined) {
        const roster = profiles.rosterRef;
        if (!roster) {
          throw new UserProfileError("班级库未加载，请联系管理员");
        }
        if (!roster.hasClass(parsed.fields.className)) {
          throw new UserProfileError(`班级「${parsed.fields.className}」不在班级库中`);
        }
      }
      if (parsed.fields.name !== undefined) {
        const name = parsed.fields.name.replace(/\s+/gu, "");
        if (name.length === 0 || name.length > 20) {
          throw new UserProfileError("姓名需要 1-20 个字符（不含空格）");
        }
      }
    } catch (error) {
      return {
        ok: false,
        text: `设置失败：${formatError(error)}\n\n${formatParseNotes(parsed)}`,
      };
    }
    // 学号先写（确定年级），班级再写（自动带出学院/年级），显式学院/年级最后覆盖，姓名垫底。
    const order: UserProfileField[] = ["studentId", "className", "college", "year", "name"];
    const applied: string[] = [];
    for (const key of order) {
      const value = parsed.fields[key];
      if (value === undefined) {
        continue;
      }
      try {
        profiles.set(userId, key, value);
      } catch (error) {
        return { ok: false, text: `设置失败：${formatError(error)}` };
      }
      applied.push(PROFILE_FIELD_LABELS[key]);
    }
    const lines = [`已更新：${applied.join("、")}`];
    const notes = formatParseNotes(parsed);
    if (notes.length > 0) {
      lines.push(notes);
    }
    lines.push("", this.formatProfile(userId));
    return { ok: true, text: lines.join("\n") };
  }

  private formatProfile(userId: string): string {
    const profile = this.userProfiles?.get(userId);
    const userLabel = this.displayUser(userId);
    if (!profile) {
      return `个人资料（${userLabel}）：尚未填写\n\n${PROFILE_USAGE}`;
    }
    return [
      `个人资料（${userLabel}）：`,
      `姓名：${profile.name || "（未填）"}`,
      `学号：${profile.studentId || "（未填）"}${
        profile.studentId && profile.year ? `（${profile.year} 级）` : ""
      }`,
      `班级：${profile.className || "（未填）"}`,
      `学院：${profile.college || "（未填）"}`,
      "",
      PROFILE_USAGE,
    ].join("\n");
  }

  // ------------------------------------------------------------ /activity

  private async handleActivity(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const activities = this.activity;
    if (!activities) {
      return { ok: false, text: "活动模块未启用。" };
    }
    const action = normalize(parts[1]);
    if (!action || action === "list" || action === "列表" || action === "查看") {
      const { page, rest } = extractPageToken(parts);
      const targetGroupId =
        this.resolveTargetGroupId(groupId, rest[1] ?? rest[0]) ?? groupId;
      if (!targetGroupId) {
        return {
          ok: false,
          text: "用法：/activity（群内查看本群活动），或 /activity list <群号|#群短码> [+页码]",
        };
      }
      return this.activityListCard(targetGroupId, userId, page);
    }
    if (parts[1]?.startsWith("#")) {
      return this.handleActivityInfo(userId, parts[1]);
    }
    switch (action) {
      case "create":
      case "创建":
      case "新建":
        return this.handleActivityCreate(groupId, userId, parts);
      case "set":
      case "设置":
      case "配置":
        return this.handleActivitySet(userId, parts, groupId);
      case "open":
      case "开始":
      case "发布":
        return this.handleActivityOpen(userId, parts, groupId);
      case "close":
      case "关闭":
        return this.handleActivityStatus(userId, parts, "close", groupId);
      case "cancel":
      case "取消活动":
        return this.handleActivityStatus(userId, parts, "cancel", groupId);
      case "join":
      case "报名":
        return this.handleActivityJoin(groupId, userId, parts);
      case "quit":
      case "取消报名":
        return this.handleActivityQuit(groupId, userId, parts);
      case "info":
      case "详情":
        return this.handleActivityInfo(userId, parts[2]);
      case "signups":
      case "名单":
        return this.handleActivitySignups(userId, parts, groupId);
      case "subscribe":
      case "订阅":
        return this.subscribeCard(groupId, userId, parts[2]);
      case "bind":
      case "绑定群":
        return this.handleActivityBindCommand(userId, parts);
      case "unbind":
      case "解绑群":
        return this.handleActivityUnbindCommand(userId, parts);
      case "unsubscribe":
      case "退订":
        return this.subscribeCard(groupId, userId, parts[2], false);
      case "manage":
      case "管理":
        return this.activityManageCard(userId, parts[2]);
      case "config":
        return this.activityConfigCard(userId, parts[2]);
      default:
        return { ok: false, text: ACTIVITY_USAGE };
    }
  }

  // ------------------------------------------- 活动：卡片构造（B2）

  /**
   * 活动通知服务未装配时的兜底（内存记录）。
   *
   * `cb:activity:subscribe:<群ID>` 只有「当前是否订阅」这一个状态，兜底表只为它而存在；
   * 正式的推送与持久化由 `ActivityNotificationService` 负责（见 runtime 装配）。
   */
  private readonly fallbackSubscriptions = new Set<string>();

  /** 统一构造活动卡片输入（补齐名单 / 候补 / 展示群名 / 查看者权限）。 */
  private activityCardInput(
    activity: Activity,
    userId: string,
    extra: { full?: boolean; page?: number } = {},
  ): ActivityCardInput {
    const registrations = this.activity!.listRegistrations(activity.activityId);
    return {
      activity,
      registrations,
      waitlist: this.activity!.listWaitlist(activity.activityId),
      boundGroups: this.activity!.listBoundGroups(activity.activityId),
      groupLabel: activity.groupNumber || this.displayGroup(activity.groupId),
      viewerId: userId,
      canManage: this.canManageActivity(userId, activity),
      ...extra,
    };
  }

  /**
   * 活动卡片发送器：优先用显式注入的 `cardSender`，其次 `richMessages`，
   * 最后复用通知服务的发送器（生产装配三者等价，都是同一通道）。
   */
  private cardSender(): RichMessageSender | undefined {
    return (
      this.explicitCardSender ??
      this.richMessages ??
      this.notifications?.richMessageSender
    );
  }

  private activityCardService(): ActivityCardService {
    const cards = this.activityCards;
    if (cards) {
      return cards;
    }
    // 未装配卡片服务时（极简单测）用最小依赖现建一个，保证活动指令仍是卡片。
    return new ActivityCardService({
      activity: this.activity,
      display: this.display,
      // 绑定群子卡：群里显示绑定号 / 短码，不暴露 openid
      groupLabel: (groupId) => this.displayGroup(groupId),
      ...(this.userProfiles ? { profiles: this.userProfiles } : {}),
      ...(this.activityRoster ? { roster: this.activityRoster } : {}),
      // 「统计图片」按钮只在**既能渲染又能发送**时生成，避免出现点了没反应的入口
      ...(this.activityStatsService?.canSend
        ? { stats: this.activityStatsService }
        : {}),
      ...(this.activityExportService
        ? { exportService: this.activityExportService }
        : {}),
      isSubscribed: (groupId, id) => this.isSubscribedTo(groupId, id),
    });
  }

  private isSubscribedTo(groupId: string, userId: string): boolean {
    if (this.activityNotifications) {
      return this.activityNotifications.isSubscribed(groupId, userId);
    }
    return this.fallbackSubscriptions.has(`${groupId}\u0000${userId}`);
  }

  /**
   * 订阅开关（`cb:activity:subscribe` / `/activity subscribe`）：任意成员可切换。
   *
   * 订阅是**按群**的：只在发布新活动时给订阅者私信，不发群消息（主动消息有限额）。
   */
  private subscribeCard(
    groupId: string | undefined,
    userId: string,
    rawTarget?: string,
    enabled?: boolean,
  ): CardResult {
    const targetGroupId =
      rawTarget !== undefined && rawTarget.length > 0
        ? (this.resolveTargetGroupId(undefined, rawTarget) ?? rawTarget)
        : groupId;
    if (!targetGroupId) {
      const card = renderCard({
        title: "新活动订阅",
        lines: [
          "该指令需要在群内使用，或在私信中带上群号 / #群短码。",
          "用法：/activity subscribe <群号|#群短码>；/activity unsubscribe",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "topic", "activity")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const subscribed = this.isSubscribedTo(targetGroupId, userId);
    const next = enabled ?? (rawTarget === undefined ? !subscribed : true);
    const changed = next !== subscribed;
    if (changed) {
      if (next) {
        if (this.activityNotifications) {
          this.activityNotifications.subscribe(targetGroupId, userId);
        } else {
          this.fallbackSubscriptions.add(`${targetGroupId}\u0000${userId}`);
        }
      } else if (this.activityNotifications) {
        this.activityNotifications.unsubscribe(targetGroupId, userId);
      } else {
        this.fallbackSubscriptions.delete(`${targetGroupId}\u0000${userId}`);
      }
      log.info("activity subscription toggled", {
        groupId: targetGroupId,
        userId,
        subscribed: next,
      });
    }
    const groups = this.activityNotifications
      ? this.activityNotifications.listSubscribedGroups(userId)
      : [...this.fallbackSubscriptions]
          .map((key) => key.split("\u0000")[0] ?? "")
          .filter((id) => id.length > 0);
    const lines = [
      `**本群**：${this.groupLabel(targetGroupId)}`,
      `**订阅状态**：${next ? "已订阅" : "未订阅"}`,
      changed ? `**结果**：已${next ? "订阅" : "取消订阅"}新活动通知` : "**结果**：订阅状态未变化",
      "",
      "订阅后：该群发布新活动时会私信发你一张活动卡；不会再往群里发通知。",
      groups.length > 0
        ? `**已订阅的群**：${groups.map((id) => this.groupLabel(id)).join("、")}`
        : "**已订阅的群**：无",
      "",
      "说明：机器人无法 @全体成员；主动私信有人数限额，因此只推送给订阅者与当事人。",
    ];
    return cardFromText("新活动订阅", lines.join("\n"), {
      rows: [
        [
          viewButton(
            "toggle",
            next ? "订阅 开" : "订阅 关",
            "activity",
            "subscribe",
            targetGroupId,
            next ? "off" : "on",
          ),
          viewButton("help", "订阅帮助", "help", "topic", "activity"),
        ],
      ],
      buttonHint: "点击切换：",
    });
  }

  /** 管理卡入口（管理者专用）。 */
  private activityManageCard(userId: string, rawCode?: string): CardResult {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("需要群管理员或活动发布者权限。");
    }
    return {
      ok: true,
      text: this.activityCardService()
        .manageCard(this.activityCardInput(activity, userId))
        .markdown,
      rich: this.activityCardService().manageCard(this.activityCardInput(activity, userId)),
    };
  }

  /** 配置卡入口（管理者专用）。 */
  private activityConfigCard(userId: string, rawCode?: string): CardResult {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("需要群管理员或活动发布者权限。");
    }
    const rich = this.activityCardService().configCard(
      this.activityCardInput(activity, userId),
    );
    return { ok: true, text: rich.text, rich };
  }

  /** 活动不存在的统一卡片（回调里短码解析失败也走这里）。 */
  private activityNotFoundCard(rawCode: string): CardResult {
    const card = renderCard({
      title: "活动不存在",
      lines: [
        `没有找到活动：${escapeCardText(rawCode) || "（空短码）"}`,
        "短码形如 #A7K2Q9，可从活动列表或活动卡片上复制。",
      ],
      rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  private activityDeniedCard(reason: string): CardResult {
    const card = renderCard({
      title: "权限不足",
      lines: [reason],
      rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  /** 活动成员卡（群内展示 / 预览 / 重发）。 */
  public activityMemberCard(activity: Activity, viewerId: string): RichMessage {
    return this.activityCardService().memberCard(
      this.activityCardInput(activity, viewerId),
    );
  }

  // ------------------------------------------- 活动：回调 renderer（B2）

  /**
   * `cb:activity:*` 的总入口。
   *
   * 每个 action 在这里**重新做权限校验**（不能信按钮）：
   * - 报名 / 取消报名 / 订阅 = 任意成员；
   * - 配置 / 发布 / 关停 / 释放 / 名单 / 导出 / 统计 = `canManageActivity` 或超管；
   * - 名单 / 统计 / 导出在各自 handler 里再校验一次。
   *
   * `replyGroupId` 是**用户点击所在的群**（私聊点击时为 undefined），用于决定
   * 回执落在群里还是私聊 —— 隐私字段只在私聊出现（用户确认的落点）。
   *
   * 返回 `undefined` 表示「这个回调不该产生消息」（§B4 群内静默：结果已经私信出去）。
   */
  public async activityCallbackCard(
    action: string,
    args: readonly string[],
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult | undefined> {
    if (!this.activity) {
      return this.activityDeniedCard("活动模块未启用。");
    }
    switch (action) {
      case "join": {
        // §B4：群里点「我要报名」→ 结果只私信，群内静默（renderer 返回 undefined）。
        // 回调路径用 `dmSilent: false`，因此「已私信成功」= 返回 undefined；
        // 只有私信失败时才会拿到一张**不含结果**的兜底卡。
        if (replyGroupId !== undefined) {
          const silentResult = await this.joinActivityCard(replyGroupId, userId, [
            "activity",
            "join",
            args[0] ?? "",
          ], { dmOnly: true, dmSilent: false });
          // undefined = 已私信成功（群内静默）；兜底提示卡要发到群里
          return silentResult;
        }
        return this.joinActivityCard(undefined, userId, ["activity", "join", args[0] ?? ""], {
          dmOnly: false,
          dmSilent: false,
        });
      }
      case "quit": {
        // §B4：群里点「取消报名」→ 结果只私信，群内静默
        if (replyGroupId !== undefined) {
          const silentResult = await this.quitActivityCard(replyGroupId, userId, [
            "activity",
            "quit",
            args[0] ?? "",
          ], { dmOnly: true, dmSilent: false });
          // undefined = 已私信成功（群内静默）；兜底提示卡要发到群里
          return silentResult;
        }
        return this.quitActivityCard(undefined, userId, ["activity", "quit", args[0] ?? ""], {
          dmOnly: false,
          dmSilent: false,
        });
      }
      case "info":
        return this.activityInfoCard(userId, args[0]);
      case "signups":
        return this.handleActivitySignups(
          userId,
          ["activity", "signups", args[0] ?? "", args[2] ? "full" : ""],
          replyGroupId,
          { page: Number.parseInt(args[1] ?? "1", 10) || 1, full: args[2] === "full" },
        );
      case "page":
        return this.activityListCard(
          args[0] ?? replyGroupId ?? "",
          userId,
          Number.parseInt(args[1] ?? "1", 10) || 1,
        );
      case "config":
        return this.activityConfigCard(userId, args[0]);
      case "manage":
        return this.activityManageCard(userId, args[0]);
      case "preview":
        return this.activityPreviewCard(userId, args[0]);
      case "bindings":
        return this.handleActivityBindingsCard(userId, args[0], args[1]);
      case "bind":
        return this.handleActivityBindInstruction(userId, args[0]);
      case "unbind":
        return this.handleActivityUnbind(userId, args[0], args[1], args[2]);
      case "open":
        return this.handleActivityOpen(
          userId,
          ["activity", "open", args[0] ?? ""],
          replyGroupId,
        );
      case "cancel":
        return this.handleActivityStatus(
          userId,
          ["activity", "cancel", args[0] ?? ""],
          "cancel",
          replyGroupId,
        );
      case "release":
        return this.handleActivityRelease(userId, args[0], replyGroupId);
      case "resend":
        return this.handleActivityResend(userId, args[0], replyGroupId);
      case "status":
        return this.handleActivityStatus(
          userId,
          ["activity", args[1] === "open" ? "open" : "close", args[0] ?? ""],
          args[1] === "open" ? "open" : "close",
          replyGroupId,
        );
      case "set":
        return this.handleActivitySetCallback(
          userId,
          args[0],
          args[1],
          args[2],
          replyGroupId,
        );
      case "college":
      case "year":
        return this.handleActivityRuleToggle(
          action,
          userId,
          args[0],
          args[1],
          Number.parseInt(args[2] ?? "1", 10) || 1,
          args[3],
          replyGroupId,
        );
      case "subscribe":
        return this.subscribeCard(
          replyGroupId,
          userId,
          args[0],
          args[1] === "on" ? true : args[1] === "off" ? false : undefined,
        );
      case "stats":
        return this.handleActivityStats(userId, args[0], replyGroupId);
      case "export":
        return this.handleActivityExport(userId, args[0], replyGroupId);
      default: {
        const card = renderCard({
          title: "活动操作",
          lines: [
            `不认识的按钮动作：${escapeCardText(action) || "（空）"}`,
            "请重新打开活动卡片再操作。",
          ],
          rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
        });
        return { ok: false, text: card.text, rich: card };
      }
    }
  }

  /** `cb:activity:info:<短码>`：详情卡（含查看者自己的权限入口）。 */
  private activityInfoCard(userId: string, rawCode?: string): CardResult {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const activity = found.activity;
    const registrations = this.activity!.listRegistrations(activity.activityId);
    const canManage = this.canManageActivity(userId, activity);
    const registration = this.activity!.findRegistration(activity.activityId, userId);
    const waitlist = this.activity!.findWaitlistEntry(activity.activityId, userId);
    const lines = [
      `**状态**：${activity.status}`,
      `**群**：${activity.groupNumber || this.displayGroup(activity.groupId)}`,
      `**报名**：${registrations.length}${activity.capacity ? ` / ${activity.capacity}` : ""}${
        activity.heldSlots > 0 ? `（待释放 ${activity.heldSlots}）` : ""
      }`,
      `**候补**：${this.activity!.listWaitlist(activity.activityId).length}`,
      registration ? "**你的状态**：已报名" : waitlist ? `**你的状态**：候补第 ${this.activity!.waitlistPosition(activity.activityId, userId) ?? 0} 位` : "**你的状态**：未报名",
    ];
    if (activity.description) {
      lines.push("", escapeCardText(activity.description));
    }
    const row: CardButton[] = [
      viewButton("join", "我要报名", "activity", "join", activityCode(activity)),
      viewButton("quit", "取消报名", "activity", "quit", activityCode(activity)),
    ];
    const card = renderCard({
      title: `活动详情 ${activityCode(activity)}`,
      lines,
      rows: [
        row,
        canManage
          ? [
              viewButton("manage", "管理", "activity", "manage", activityCode(activity)),
              viewButton("config", "配置", "activity", "config", activityCode(activity)),
            ]
          : [
              viewButton(
                "subscribe",
                this.isSubscribedTo(activity.groupId, userId) ? "订阅 开" : "订阅 关",
                "activity",
                "subscribe",
                activity.groupId,
                this.isSubscribedTo(activity.groupId, userId) ? "off" : "on",
              ),
            ],
      ],
      buttonHint: "点击操作：",
      footer: [
        `报名：/activity join ${activityCode(activity)}`,
        `报名名单：/activity signups ${activityCode(activity)}（管理者）`,
      ],
    });
    return { ok: true, text: card.text, rich: card };
  }

  /** `cb:activity:bindings:<短码>[:<页码>]`：绑定群子卡（管理者专用）。 */
  private handleActivityBindingsCard(
    userId: string,
    rawCode?: string,
    rawPage?: string,
  ): CardResult {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("管理绑定群需要群管理员或活动发布者权限。");
    }
    const rich = this.activityCardService().bindGroupsCard({
      activity,
      groups: this.activity!.listBoundGroups(activity.activityId),
      page: Number.parseInt(rawPage ?? "1", 10) || 1,
    });
    return { ok: true, text: rich.text, rich };
  }

  /** `cb:activity:bind:<短码>`：绑定是自由文本动作 → 回一张预填指令的卡。 */
  private handleActivityBindInstruction(userId: string, rawCode?: string): CardResult {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("管理绑定群需要群管理员或活动发布者权限。");
    }
    const rich = this.activityCardService().bindGroupsCard({
      activity,
      groups: this.activity!.listBoundGroups(activity.activityId),
    });
    const code = activityCode(activity);
    const card = renderCard({
      title: `绑定群 ${code}`,
      lines: [
        "点下方「绑定群」会把指令填进输入框，补上群号或 #群短码再发送即可。",
        "",
        ...rich.markdown.split("\n"),
      ],
      rows: [
        [
          actionButton("bind", "绑定群", `/activity bind ${code} `),
          viewButton("back", "返回配置", "activity", "config", code),
        ],
      ],
      footer: [
        `绑定：/activity bind ${code} <群号|#群短码>`,
        `解绑：/activity unbind ${code} <群号|#群短码>`,
      ],
    });
    return { ok: true, text: card.text, rich: card };
  }

  /** `cb:activity:unbind:<短码>:<群ID>:<页码>`：解绑固定动作，点一下就生效。 */
  private handleActivityUnbind(
    userId: string,
    rawCode?: string,
    rawGroupId?: string,
    rawPage?: string,
  ): CardResult {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("管理绑定群需要群管理员或活动发布者权限。");
    }
    if (!rawGroupId) {
      return this.activityDeniedCard("回调参数不完整，请重新打开绑定群卡片。");
    }
    const removed = this.activity!.unbindGroup(activity.activityId, rawGroupId);
    const groups = this.activity!.listBoundGroups(activity.activityId);
    const rich = this.activityCardService().bindGroupsCard({
      activity,
      groups,
      page: Number.parseInt(rawPage ?? "1", 10) || 1,
    });
    const body = removed
      ? `**结果**：已解绑 ${this.displayGroup(rawGroupId)}。`
      : `**结果**：${this.displayGroup(rawGroupId)} 本来就没有绑定（可能已经被解绑）。`;
    const card = renderCard({
      title: `绑定群 ${activityCode(activity)}`,
      lines: [body, "", ...rich.markdown.split("\n")],
      rows: [
        [
          actionButton("bind", "绑定群", `/activity bind ${activityCode(activity)} `),
          viewButton("back", "返回配置", "activity", "config", activityCode(activity)),
        ],
      ],
      footer: [
        `解绑：/activity unbind ${activityCode(activity)} <群号|#群短码>`,
      ],
    });
    return { ok: true, text: card.text, rich: card };
  }

  /** `/activity bind <#短码> <群号|#群短码>`：绑定发布 / 广播目标群。 */
  private handleActivityBindCommand(
    userId: string,
    parts: readonly string[],
  ): CardResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return this.activityNotFoundCard(parts[2] ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("绑定群需要群管理员或活动发布者权限。");
    }
    const targetGroupId = this.resolveActivityGroupArg(parts[3]);
    if (!targetGroupId) {
      return this.activityDeniedCard(
        `请提供群号或 #群短码：/activity bind ${activityCode(activity)} <群号|#群短码>`,
      );
    }
    const added = this.activity!.bindGroup(activity.activityId, targetGroupId);
    log.info("activity group binding changed", {
      activityId: activity.activityId,
      groupId: targetGroupId,
      added,
      operator: userId,
    });
    return this.activityBindingsResultCard(
      userId,
      activity,
      added
        ? `**结果**：已绑定 ${this.displayGroup(targetGroupId)}（发布与满员广播都会发到这个群）。`
        : `**结果**：${this.displayGroup(targetGroupId)} 已经绑定过了。`,
    );
  }

  /** `/activity unbind <#短码> <群号|#群短码>`：解绑目标群。 */
  private handleActivityUnbindCommand(
    userId: string,
    parts: readonly string[],
  ): CardResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return this.activityNotFoundCard(parts[2] ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("解绑群需要群管理员或活动发布者权限。");
    }
    const targetGroupId = this.resolveActivityGroupArg(parts[3]);
    if (!targetGroupId) {
      return this.activityDeniedCard(
        `请提供群号或 #群短码：/activity unbind ${activityCode(activity)} <群号|#群短码>`,
      );
    }
    const removed = this.activity!.unbindGroup(activity.activityId, targetGroupId);
    log.info("activity group binding changed", {
      activityId: activity.activityId,
      groupId: targetGroupId,
      added: false,
      removed,
      operator: userId,
    });
    return this.activityBindingsResultCard(
      userId,
      activity,
      removed
        ? `**结果**：已解绑 ${this.displayGroup(targetGroupId)}。`
        : `**结果**：${this.displayGroup(targetGroupId)} 本来就没有绑定。`,
    );
  }

  /** 绑定 / 解绑后的统一反馈：绑定群子卡 + 结果行。 */
  private activityBindingsResultCard(
    userId: string,
    activity: Activity,
    notice: string,
  ): CardResult {
    const fresh = this.activity!.getActivity(activity.activityId);
    const rich = this.activityCardService().bindGroupsCard({
      activity: fresh,
      groups: this.activity!.listBoundGroups(fresh.activityId),
    });
    const code = activityCode(fresh);
    const card = renderCard({
      title: `绑定群 ${code}`,
      lines: [notice, "", ...rich.markdown.split("\n")],
      rows: [
        [
          actionButton("bind", "绑定群", `/activity bind ${code} `),
          viewButton("back", "返回配置", "activity", "config", code),
        ],
        [viewButton("manage", "返回管理", "activity", "manage", code)],
      ],
      footer: [
        `绑定：/activity bind ${code} <群号|#群短码>`,
        `解绑：/activity unbind ${code} <群号|#群短码>`,
      ],
    });
    return { ok: true, text: card.text, rich: card };
  }

  /**
   * 绑定参数解析：群号 / `#群短码` / 内部群 ID 都接受。
   *
   * 解析使用与其它指令相同的 `resolveTargetGroupId`（群号与短码都走身份库），
   * 因此不会把「活动短码」误当成群号（活动短码带 `#` 时先剥离再查群）。
   */
  private resolveActivityGroupArg(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    return this.resolveTargetGroupId(undefined, trimmed);
  }

  /** `cb:activity:preview:<短码>`：把成员卡预览给操作者本人（不发群）。 */
  private activityPreviewCard(userId: string, rawCode?: string): CardResult {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    if (!this.canManageActivity(userId, found.activity)) {
      return this.activityDeniedCard("预览活动卡片需要群管理员或发布者权限。");
    }
    const rich = this.activityCardService().memberCard(
      this.activityCardInput(found.activity, userId),
    );
    return { ok: true, text: rich.text, rich };
  }

  private async handleActivityStats(
    userId: string,
    rawCode?: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    // 统计图含学号/学院分布，必须再校验一次管理权限
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("统计需要群管理员或活动发布者权限。");
    }
    const stats = this.activityStatsService;
    if (!stats) {
      // §B3 未装配：降级为卡片文字统计（不报错）
      return this.activityStatsFallback(userId, activity, replyGroupId);
    }
    try {
      const buffer = await stats.render(
        activity,
        this.activity!.listRegistrations(activity.activityId),
        this.activityProfiles(activity.activityId),
      );
      if (!buffer) {
        return this.activityStatsFallback(userId, activity, replyGroupId);
      }
      const sent = await stats.sendImageToGroup?.(
        activity.groupId,
        buffer,
        `activity-${activity.code}.png`,
      );
      if (!sent?.ok) {
        // 渲染成功但发送失败（未装配通道 / 上传失败）：同样降级为文字统计
        log.warn("activity stats image delivery unavailable", {
          activityId: activity.activityId,
          detail: sent?.detail ?? "未装配发送通道",
        });
        return this.activityStatsFallback(userId, activity, replyGroupId);
      }
      return this.activityNoticeCard(
        replyGroupId,
        userId,
        "**结果**：已发送统计图片。",
      );
    } catch (error) {
      log.warn("activity stats render failed", {
        activityId: activity.activityId,
        error: formatError(error),
      });
      return this.activityStatsFallback(userId, activity, replyGroupId);
    }
  }

  /** 统计/导出用的资料表：只带上确实有资料的报名者。 */
  private activityProfiles(
    activityId: string,
  ): Map<string, UserProfile> | undefined {
    const profiles = this.userProfiles;
    if (!profiles) {
      return undefined;
    }
    const map = new Map<string, UserProfile>();
    for (const registration of this.activity!.listRegistrations(activityId)) {
      const profile = profiles.get(registration.userId);
      if (profile) {
        map.set(registration.userId, profile);
      }
    }
    return map;
  }

  /** 统计降级：管理卡同款文字统计。 */
  private activityStatsFallback(
    userId: string,
    activity: Activity,
    replyGroupId?: string,
  ): CardResult {
    const rich = this.activityCardService().manageCard(
      this.activityCardInput(activity, userId),
    );
    const notice = this.mention(replyGroupId, userId).trimEnd();
    const lines = notice ? [notice, ...(rich.markdown.split("\n"))] : rich.markdown.split("\n");
    const card = renderCard({
      title: `活动统计 ${activityCode(activity)}`,
      lines,
      rows: [
        [
          viewButton("manage", "返回管理", "activity", "manage", activityCode(activity)),
        ],
      ],
      footer: ["统计图片不可用（服务未装配或字体缺失），以上为文字统计。"],
    });
    return { ok: true, text: card.text, rich: card };
  }

  private async handleActivityExport(
    userId: string,
    rawCode?: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("导出名单需要群管理员或活动发布者权限。");
    }
    const exporter = this.activityExportService;
    const notice = this.mention(replyGroupId, userId).trimEnd();
    if (!exporter) {
      return this.activityNoticeCard(
        replyGroupId,
        userId,
        "**结果**：导出服务未装配，暂无法生成 CSV。可用「报名名单」查看并复制。",
      );
    }
    const result = await exporter.exportCsv({
      activity,
      registrations: this.activity!.listRegistrations(activity.activityId),
      waitlist: this.activity!.listWaitlist(activity.activityId),
      operatorId: userId,
    });
    return this.activityNoticeCard(
      replyGroupId,
      userId,
      `**结果**：${result.ok ? result.text : `导出失败：${result.text}`}`,
    );
  }

  /** 回调反馈卡：群里首行 @ 操作人，私聊直接给结果。 */
  private activityNoticeCard(
    replyGroupId: string | undefined,
    userId: string,
    body: string,
  ): CardResult {
    const mention = this.mention(replyGroupId, userId).trimEnd();
    const card = renderCard({
      title: "活动操作",
      lines: [...(mention ? [mention] : []), body],
      rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
    });
    return { ok: true, text: card.text, rich: card };
  }

  /**
   * `cb:activity:resend:<短码>`：把成员卡重发到活动群（管理者专用）。
   *
   * 管理卡上的「重发卡片」是发布卡片的补救入口（例如原来那条被刷屏冲走）。
   */
  private async handleActivityResend(
    userId: string,
    rawCode?: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("重发卡片需要群管理员或活动发布者权限。");
    }
    const sender = this.cardSender();
    if (!sender) {
      return this.activityNoticeCard(
        replyGroupId,
        userId,
        "**结果**：发送通道未启用，无法重发卡片。",
      );
    }
    // §B4：重发同样打到**所有绑定群**
    const card = this.activityMemberCard(activity, userId);
    const sent: string[] = [];
    const failed: string[] = [];
    for (const groupId of this.activity!.listBoundGroups(activity.activityId)) {
      const result = await sender.sendToGroup(groupId, card);
      if (result.ok) {
        sent.push(groupId);
      } else {
        failed.push(groupId);
        log.warn("activity resend failed for group", {
          activityId: activity.activityId,
          groupId,
          error: result.detail,
        });
      }
    }
    return this.activityNoticeCard(
      replyGroupId,
      userId,
      `**结果**：已重发活动卡片（成功 ${sent.length} 个 / 失败 ${failed.length} 个）${
        failed.length > 0
          ? `：失败群 ${formatGroupList(failed, (id) => this.displayGroup(id))}`
          : "。"
      }`,
    );
  }

  /**
   * `cb:activity:release:<短码>`：释放一个冻结名额（手动递补模式）。
   *
   * 有候补 → 递补第一位（私信通知本人，**不往群里发**）；没有候补 → 名额放回公开池。
   */
  private async handleActivityRelease(
    userId: string,
    rawCode?: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("释放名额需要群管理员或活动发布者权限。");
    }
    const released = this.activity!.releaseHeldSlot(activity.activityId);
    if (!released) {
      return this.activityManageNotice(userId, activity, replyGroupId, {
        ok: false,
        text: "**结果**：没有待释放的名额（可能已经被释放）。",
      });
    }
    if (released.promoted && released.registration) {
      const total = this.activity!.listRegistrations(activity.activityId).length;
      await this.notifyPromoted(activity, released.promoted, total);
      log.info("activity held slot released: promoted", {
        activityId: activity.activityId,
        promoter: userId,
        promoted: released.promoted.userId,
      });
      return this.activityManageNotice(userId, activity, replyGroupId, {
        ok: true,
        text: `**结果**：已释放名额并递补候补第一位（当前 ${total}${
          activity.capacity ? ` / ${activity.capacity}` : ""
        }），已私信通知本人。`,
      });
    }
    log.info("activity held slot released: opened", {
      activityId: activity.activityId,
      operator: userId,
    });
    return this.activityManageNotice(userId, activity, replyGroupId, {
      ok: true,
      text: "**结果**：已释放名额，当前没有候补，名额放回公开池（先到先得）。",
    });
  }

  /** 管理类回调的统一反馈卡：刷新后的管理卡 + 结果行。 */
  private activityManageNotice(
    userId: string,
    activity: Activity,
    replyGroupId: string | undefined,
    outcome: { ok: boolean; text: string },
  ): CardResult {
    const fresh = this.activity!.getActivity(activity.activityId);
    const rich = this.activityCardService().manageCard(
      this.activityCardInput(fresh, userId),
    );
    const mention = this.mention(replyGroupId, userId).trimEnd();
    const lines = [
      ...(mention ? [mention] : []),
      outcome.text,
      "",
      ...rich.markdown.split("\n"),
    ];
    const card = renderCard({
      title: `活动管理 ${activityCode(fresh)}`,
      lines,
      rows: [
        [
          viewButton("signups", "报名名单", "activity", "signups", activityCode(fresh), 1),
          viewButton("resend", "重发卡片", "activity", "resend", activityCode(fresh)),
        ],
        [
          viewButton("manage", "刷新管理", "activity", "manage", activityCode(fresh)),
        ],
      ],
      buttonHint: "操作：",
      footer: [`活动配置：/activity info ${activityCode(fresh)}`],
    });
    return { ok: outcome.ok, text: card.text, rich: card };
  }

  /** `cb:activity:set:<短码>:<字段>:<值>`：配置卡上的快捷设置（管理者专用）。 */
  private async handleActivitySetCallback(
    userId: string,
    rawCode?: string,
    field?: string,
    value?: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("修改活动需要群管理员或活动发布者权限。");
    }
    if (!field || value === undefined) {
      return this.activityDeniedCard("回调参数不完整，请重新打开配置卡。");
    }
    const applied = this.applyActivitySetting(
      activity,
      field,
      value,
      ACTIVITY_NOTIFY_FIELDS.has(field),
    );
    if (!applied.ok) {
      const rich = this.activityCardService().configCard(
        this.activityCardInput(activity, userId),
      );
      const mention = this.mention(replyGroupId, userId).trimEnd();
      const card = renderCard({
        title: "活动未修改",
        lines: [
          ...(mention ? [mention] : []),
          `**结果**：${applied.text}`,
          "",
          ...rich.markdown.split("\n"),
        ],
        rows: [
          [viewButton("config", "返回配置", "activity", "config", activityCode(activity))],
        ],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const updated = this.activity!.getActivity(activity.activityId);
    const rich = this.activityCardService().configCard(
      this.activityCardInput(updated, userId),
    );
    const mention = this.mention(replyGroupId, userId).trimEnd();
    const card = renderCard({
      title: `活动配置 ${activityCode(updated)}`,
      lines: [...(mention ? [mention] : []), applied.text, "", ...rich.markdown.split("\n")],
      rows: [
        [
          viewButton("preview", "预览", "activity", "preview", activityCode(updated)),
          viewButton("open", "开放报名", "activity", "open", activityCode(updated)),
        ],
      ],
      buttonHint: "配置项在卡片下方按钮上：",
      footer: [`活动管理：/activity set ${activityCode(updated)} <字段> <值>`],
    });
    return { ok: applied.ok, text: card.text, rich: card };
  }

  /**
   * `cb:activity:college|year:<短码>:<mode>:<页码>[:<取值>]`：
   * 学院 / 年级限制子卡的点选（管理者专用）。
   */
  private async handleActivityRuleToggle(
    kind: "college" | "year",
    userId: string,
    rawCode?: string,
    rawMode?: string,
    page = 1,
    option?: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("修改限制需要群管理员或活动发布者权限。");
    }
    const mode: "allow" | "deny" = rawMode === "deny" ? "deny" : "allow";
    if (option !== undefined) {
      const applied = this.applyActivityRuleOption(kind, mode, activity, option);
      if (!applied.ok) {
        return this.activityManageNotice(userId, activity, replyGroupId, applied);
      }
      log.info("activity rule toggled", {
        activityId: activity.activityId,
        kind,
        mode,
        option,
        userId,
      });
    }
    const updated = this.activity!.getActivity(activity.activityId);
    const rich = this.activityCardService().rulesCard({
      activity: updated,
      kind,
      mode,
      page,
    });
    const label = kind === "college" ? "学院限制" : "年级限制";
    return { ok: true, text: rich.text, rich: this.attachNotice(rich, label) };
  }

  /** 规则子卡的提示：点选后回到同一张子卡（标题即位置）。 */
  private attachNotice(rich: RichMessage, label: string): RichMessage {
    return {
      ...rich,
      markdown: `**${label}**\n${rich.markdown}`,
      text: `【${label}】\n${rich.text}`,
    };
  }

  /**
   * 学院 / 年级白黑名单的点选逻辑。
   *
   * `clear` 清空当前列表；否则在「当前模式」的列表里切换该取值。
   */
  private applyActivityRuleOption(
    kind: "college" | "year",
    mode: "allow" | "deny",
    activity: Activity,
    option: string,
  ): { ok: boolean; text: string } {
    const isAllow = mode === "allow";
    const current = new Set(
      kind === "college"
        ? isAllow
          ? activity.allowColleges
          : activity.denyColleges
        : isAllow
          ? activity.allowYears
          : activity.denyYears,
    );
    const cleaned = option.trim();
    if (cleaned === "clear") {
      current.clear();
    } else if (cleaned.length === 0) {
      return { ok: false, text: "**结果**：没有识别到要切换的取值。" };
    } else if (current.has(cleaned)) {
      current.delete(cleaned);
    } else {
      current.add(cleaned);
    }
    const next = [...current].sort();
    try {
      if (kind === "college") {
        this.activity!.updateActivity(
          activity.activityId,
          isAllow ? { allowColleges: next } : { denyColleges: next },
        );
      } else {
        this.activity!.updateActivity(
          activity.activityId,
          isAllow ? { allowYears: next } : { denyYears: next },
        );
      }
    } catch (error) {
      return { ok: false, text: `**结果**：${formatError(error)}` };
    }
    const label = kind === "college" ? "学院" : "年级";
    return {
      ok: true,
      text:
        cleaned === "clear"
          ? `**结果**：已清空${isAllow ? "允许" : "禁止"}${label}（表示不限）。`
          : `**结果**：已更新${isAllow ? "允许" : "禁止"}${label}：${next.join("、") || "（空）"}`,
    };
  }

  private requireActivity(
    code: string | undefined,
  ): { ok: true; activity: Activity } | { ok: false; text: string } {
    if (!code) {
      return { ok: false, text: ACTIVITY_USAGE };
    }
    try {
      return { ok: true, activity: this.activity!.requireByCode(code) };
    } catch (error) {
      return { ok: false, text: `活动不存在：${code}` };
    }
  }

  private canManageActivity(userId: string, activity: Activity): boolean {
    return (
      this.permissions.isSuperAdmin(userId) ||
      activity.createdBy === userId ||
      this.permissions.canApproveJoin(userId, activity.groupId)
    );
  }

  /**
   * 活动字段应用（`/activity set` 与配置卡回调共用一条路径）。
   *
   * - 布尔开关接受 `on/off/true/false/开/关`；
   * - `clear` 清空（链接、限制、名额、截止、简介）；
   * - `closeAt` 接受 `MM-DD HH:mm`（默认当年）或 `YYYY-MM-DD HH:mm`；
   * - `notify` 为真时，改到「当事人关心的字段」会给已报名 + 候补私信一次变更通知。
   */
  private applyActivitySetting(
    activity: Activity,
    field: string,
    value: string,
    notify: boolean,
  ): { ok: boolean; text: string } {
    const activities = this.activity!;
    const cleared = CLEAR_WORDS.has(value.trim().toLowerCase());
    try {
      switch (field) {
        case "title":
        case "标题":
          if (cleared) {
            return { ok: false, text: "标题不能清空，请填写新的标题。" };
          }
          activities.updateActivity(activity.activityId, { title: value });
          break;
        case "desc":
        case "description":
        case "描述":
          activities.updateActivity(activity.activityId, {
            description: cleared ? "" : value,
          });
          break;
        case "capacity":
        case "名额":
          activities.updateActivity(activity.activityId, {
            capacity: cleared ? undefined : parsePositiveInt(field, value),
          });
          break;
        case "group":
        case "群号":
          activities.updateActivity(activity.activityId, {
            groupNumber: cleared ? "" : value,
          });
          break;
        case "link":
        case "链接":
          activities.updateActivity(activity.activityId, {
            links: cleared ? [] : [...activity.links, parseLink(value)],
          });
          break;
        case "links":
        case "链接列表":
          activities.updateActivity(activity.activityId, {
            links: cleared ? [] : parseLinks(value),
          });
          break;
        case "closeat":
        case "截止":
          activities.updateActivity(activity.activityId, {
            closeAt: cleared ? undefined : parseCloseAt(value),
          });
          break;
        case "waitlistpromotion":
        case "递补":
          return this.setWaitlistPromotion(activity, value, cleared);
        case "mentionall":
        case "提醒全体":
          activities.updateActivity(activity.activityId, {
            mentionAll: parseToggle(field, value),
          });
          break;
        case "notifycreator":
        case "通知发起人":
          activities.updateActivity(activity.activityId, {
            notifyCreator: parseToggle(field, value),
          });
          break;
        case "allowcolleges":
        case "允许学院":
          activities.updateActivity(activity.activityId, {
            allowColleges: cleared ? [] : parseList(value),
          });
          break;
        case "denycolleges":
        case "禁止学院":
        case "不允许学院":
          activities.updateActivity(activity.activityId, {
            denyColleges: cleared ? [] : parseList(value),
          });
          break;
        case "allowyears":
        case "允许年级":
          activities.updateActivity(activity.activityId, {
            allowYears: cleared ? [] : parseYearList(value),
          });
          break;
        case "denyyears":
        case "禁止年级":
        case "不允许年级":
          activities.updateActivity(activity.activityId, {
            denyYears: cleared ? [] : parseYearList(value),
          });
          break;
        default:
          return { ok: false, text: ACTIVITY_SET_USAGE };
      }
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }
    const updated = activities.getActivity(activity.activityId);
    if (notify) {
      this.voidNotifyActivityChanged(updated, field);
    }
    return { ok: true, text: `**结果**：已更新 ${field}（${activityCode(updated)}）。` };
  }

  /** 递补方式：`auto`（自动递补）会先把已有冻结名额释放掉。 */
  private setWaitlistPromotion(
    activity: Activity,
    value: string,
    cleared: boolean,
  ): { ok: boolean; text: string } {
    const activities = this.activity!;
    const normalized = normalize(value);
    const mode: "auto" | "manual" = cleared
      ? "manual"
      : normalized === "auto" || normalized === "自动" || normalized === "自动递补"
        ? "auto"
        : normalized === "manual" || normalized === "手动" || normalized === "手动释放"
          ? "manual"
          : TOGGLE_ON.has(normalized)
            ? "auto"
            : TOGGLE_OFF.has(normalized)
              ? "manual"
              : (() => {
                  throw new Error("递补方式需要 auto（自动）或 manual（手动）");
                })();
    if (mode === "auto" && activity.heldSlots > 0) {
      activities.releaseHeldSlot(activity.activityId);
    }
    activities.updateActivity(activity.activityId, { waitlistPromotion: mode });
    return {
      ok: true,
      text: `**结果**：递补方式已改为「${mode === "auto" ? "自动递补" : "手动释放名额"}」。`,
    };
  }

  /**
   * 活动变更通知（`kind: "changed"`）：私信已报名 + 候补者，**不往群里发**。
   *
   * 去重 + 每日封顶在 `ActivityNotificationService` 里统一做；没有通知服务时静默跳过。
   */
  private voidNotifyActivityChanged(activity: Activity, field: string): void {
    const notifications = this.activityNotifications;
    if (!notifications) {
      return;
    }
    const userIds = this.participantIds(activity);
    if (userIds.length === 0) {
      return;
    }
    const text = [
      `活动 **${escapeCardText(activity.title)}**（${activityCode(activity)}）有变更：`,
      `- 变更字段：${escapeCardText(field)}`,
      `- 报名：${this.activity!.listRegistrations(activity.activityId).length}${
        activity.capacity === undefined ? "" : ` / ${activity.capacity}`
      }`,
      `- 截止：${formatCloseAt(activity)}`,
      "",
      `查看详情：/activity info ${activityCode(activity)}`,
    ].join("\n");
    void notifications
      .notifyParticipants({
        activityId: activity.activityId,
        userIds,
        kind: "changed",
        text,
      })
      .catch((error: unknown) => {
        log.warn("activity change notify failed", {
          activityId: activity.activityId,
          error: formatError(error),
        });
      });
  }

  /** 发布（open）：群内发成员卡 + 私信回执 + 给订阅者私信活动卡。 */
  private async publishActivity(
    userId: string,
    rawCode: string | undefined,
    replyGroupId?: string,
  ): Promise<CardResult> {
    const found = this.requireActivity(rawCode);
    if (!found.ok) {
      return this.activityNotFoundCard(rawCode ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("发布活动需要群管理员或活动发布者权限。");
    }
    const opened = this.activity!.openActivity(activity.activityId);
    // §B4：发布到**所有绑定群**（不是只有归属群），并逐个记录成功 / 失败
    const groups = this.activity!.listBoundGroups(opened.activityId);
    const sender = this.cardSender();
    const memberCard = this.activityMemberCard(opened, userId);
    const sentGroups: string[] = [];
    const failedGroups: string[] = [];
    if (sender) {
      for (const groupId of groups) {
        const result = await sender.sendToGroup(groupId, memberCard);
        if (result.ok) {
          sentGroups.push(groupId);
        } else {
          failedGroups.push(groupId);
          log.warn("activity publish failed for group", {
            activityId: opened.activityId,
            groupId,
            error: result.detail,
          });
        }
      }
    } else {
      failedGroups.push(...groups);
    }
    const published = groups.length > 0 && failedGroups.length === 0;
    const groupReceipt = this.activityNoticeCard(
      replyGroupId,
      userId,
      published
        ? `**结果**：活动已开放报名，活动卡片已发送到 ${sentGroups.length} 个绑定群。`
        : `**结果**：活动已开放报名，卡片发送结果：成功 ${sentGroups.length} 个 / 失败 ${failedGroups.length} 个。`,
    );
    // 操作者私信回执：列出各群发送结果 + 「@全体不可用」提示 + 重发 / 关停入口
    const receiptSender = this.cardSender();
    if (receiptSender) {
      const hint = opened.mentionAll
        ? "你开启了「提醒@全体」：**机器人无法 @全体成员**，如需通知全群请手动 @ 一条。"
        : "机器人无法 @全体成员；如需通知全群请手动 @ 一条。";
      const receipt = renderCard({
        title: `活动已发布 ${activityCode(opened)}`,
        lines: [
          `**活动**：${escapeCardText(opened.title)}`,
          `**绑定群**：${groups.length} 个`,
          `**成功**：${formatGroupList(sentGroups, (id) => this.displayGroup(id)) || "（无）"}`,
          `**失败**：${formatGroupList(failedGroups, (id) => this.displayGroup(id)) || "（无）"}`,
          "",
          hint,
          "",
          `查看详情：/activity info ${activityCode(opened)}`,
        ],
        rows: [
          [
            viewButton("resend", "重发卡片", "activity", "resend", activityCode(opened)),
            viewButton("close", "关闭报名", "activity", "status", activityCode(opened), "close"),
          ],
        ],
      });
      await receiptSender
        .sendToUser(userId, receipt)
        .catch(() => undefined);
    }
    log.info("activity published", {
      activityId: opened.activityId,
      groupId: opened.groupId,
      by: userId,
      published,
    });
    await this.pushNewActivity(opened);
    return groupReceipt;
  }

  /** 给**所有绑定群**的订阅者私信新活动卡片（只发给订阅者，不群发）。 */
  private async pushNewActivity(activity: Activity): Promise<void> {
    const notifications = this.activityNotifications;
    if (!notifications) {
      return;
    }
    const card = this.activityMemberCard(activity, activity.createdBy);
    for (const groupId of this.activity!.listBoundGroups(activity.activityId)) {
      try {
        await notifications.publishNewActivity({
          activityId: activity.activityId,
          groupId,
          card,
        });
      } catch (error) {
        log.warn("activity publish push failed", {
          activityId: activity.activityId,
          groupId,
          error: formatError(error),
        });
      }
    }
  }

  /**
   * 满员广播（§B4）：本次报名后**恰好满员**时，往所有绑定群发一次「已满」卡。
   *
   * 每个群只发一次（`activity_notifications` 的 `(活动, "group:<群ID>", "full")` 去重），
   * 未装配群发送通道时静默跳过（不报错）。
   */
  private async announceActivityFull(activityId: string): Promise<void> {
    const notifications = this.activityNotifications;
    if (!notifications) {
      return;
    }
    const activity = this.activity!.getActivity(activityId);
    const capacity = activity.capacity;
    if (capacity === undefined) {
      return;
    }
    const registered = this.activity!.listRegistrations(activityId).length;
    if (registered + activity.heldSlots < capacity) {
      return;
    }
    const groups = this.activity!.listBoundGroups(activityId);
    if (groups.length === 0) {
      return;
    }
    try {
      const result = await notifications.notifyGroupsCard({
        activityId,
        groupIds: groups,
        kind: "full",
        card: this.activityCardService().fullCard(
          this.activityCardInput(activity, activity.createdBy),
        ),
      });
      log.info("activity full broadcast finished", {
        activityId,
        groups: groups.length,
        sent: result.sent,
        skipped: result.skipped,
        failed: result.failed,
        available: result.available,
      });
    } catch (error) {
      log.warn("activity full broadcast failed", {
        activityId,
        error: formatError(error),
      });
    }
  }

  /** 递补成功：私信被递补者「你已递补成功（当前 Y/Z）」，**不往群里发**。 */
  private async notifyPromoted(
    activity: Activity,
    entry: ActivityWaitlistEntry,
    total: number,
  ): Promise<void> {
    const notifications = this.activityNotifications;
    if (!notifications) {
      return;
    }
    const text = [
      `你已递补成功（活动 ${escapeCardText(activity.title)}，当前 ${total}${
        activity.capacity === undefined ? "" : ` / ${activity.capacity}`
      }）。`,
      `活动群：${activity.groupNumber || this.displayGroup(activity.groupId)}`,
      "",
      `取消报名：/activity quit ${activityCode(activity)}`,
    ].join("\n");
    await notifications
      .notifyParticipants({
        activityId: activity.activityId,
        userIds: [entry.userId],
        kind: "promoted",
        text,
        title: "候补递补成功",
      })
      .catch((error: unknown) => {
        log.warn("activity promotion notify failed", {
          activityId: activity.activityId,
          error: formatError(error),
        });
      });
  }

  /** 取消活动：私信所有已报名 + 候补者。 */
  private async notifyActivityCancelled(activity: Activity): Promise<void> {
    const notifications = this.activityNotifications;
    const userIds = this.participantIds(activity);
    if (!notifications || userIds.length === 0) {
      return;
    }
    const text = [
      `活动 **${escapeCardText(activity.title)}**（${activityCode(activity)}）已取消。`,
      `活动群：${activity.groupNumber || this.displayGroup(activity.groupId)}`,
      "",
      "如有疑问请联系活动管理者。",
    ].join("\n");
    await notifications
      .notifyParticipants({
        activityId: activity.activityId,
        userIds,
        kind: "cancelled",
        text,
        title: "活动已取消",
      })
      .catch((error: unknown) => {
        log.warn("activity cancel notify failed", {
          activityId: activity.activityId,
          error: formatError(error),
        });
      });
  }

  /** 活动的当事人（已报名 + 候补，去重）。 */
  private participantIds(activity: Activity): string[] {
    const registrations = this.activity!.listRegistrations(activity.activityId);
    const waitlist = this.activity!.listWaitlist(activity.activityId);
    return [
      ...new Set([
        ...registrations.map((item) => item.userId),
        ...waitlist.map((item) => item.userId),
      ]),
    ];
  }

  /**
   * 报名（`/activity join` 与 `cb:activity:join` 共用）。
   *
   * 消息落点（§B4 用户确认，**优先于 §B2 的 1.6**）：
   * - **群里操作**（回调或手输）：群内**一律静默**（连「原因已私信」都不发），
   *   成功 / 候补 / 失败原因全部**私信**给本人；
   * - **私聊操作**：原地回复，可含姓名 / 学号 / 班级 / 人数；
   * - **唯一例外**：私信发送失败时，允许群里回一条**不含任何结果**的提示
   *   （`<@!申请人> 私信发送失败，请先私聊机器人再试`），否则用户会以为没反应。
   *
   * `dmOnly` / `dmSilent` 由调用方给出（见 `ActivityDmOptions`）：
   * 群内回调 / 群内手输都是 `dmOnly: true`，前者 `dmSilent: false`（renderer 返回 undefined），
   * 后者 `dmSilent: true`（命令返回 `silent: true` 让 gatewayRunner 跳过群回复）；
   * 私聊（命令或回调）是 `dmOnly: false`，原地回复。
   */
  private async joinActivityCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
    dmOptions: ActivityDmOptions,
  ): Promise<CardResult | undefined> {
    const dmOnly = dmOptions.dmOnly;
    const silent = dmOptions.dmSilent;
    // 回执可以带完整信息（姓名 / 学号 / 班级）：群内私信回执与私聊原地回复都是本人可见
    const showFullReceipt = true;
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return dmOnly
        ? this.dmOnlyFailure(silent, userId, `活动不存在：${parts[2] ?? "（空短码）"}`)
        : this.activityNotFoundCard(parts[2] ?? "");
    }
    const { activity } = found;
    const profiles = this.userProfiles;
    if (!profiles) {
      const reason = "个人资料服务未启用，无法校验报名资格。";
      if (dmOnly) {
        return this.dmOnlyFailure(silent, userId, reason);
      }
      const card = renderCard({ title: "报名未通过", lines: [reason] });
      return { ok: false, text: card.text, rich: card };
    }
    let profile;
    try {
      profile = profiles.requireComplete(userId);
      this.activity!.checkEligibility(activity, profile);
    } catch (error) {
      if (error instanceof UserProfileError || error instanceof ActivityRuleError) {
        return this.activityJoinFailure(groupId, userId, activity, error.message, dmOptions);
      }
      throw error;
    }
    let outcome;
    try {
      outcome = this.activity!.joinActivity({
        activityId: activity.activityId,
        userId,
        displayName: profile.name,
        note: parts.slice(3).join(" ").trim(),
      });
    } catch (error) {
      if (error instanceof ActivityRuleError) {
        return this.activityJoinFailure(groupId, userId, activity, error.message, dmOptions);
      }
      return this.activityJoinFailure(
        groupId,
        userId,
        activity,
        formatError(error),
        dmOptions,
      );
    }
    const total = this.activity!.listRegistrations(activity.activityId).length;
    const capacity = activity.capacity;
    const ticket = capacity === undefined ? `${total}` : `${total} / ${capacity}`;
    if (outcome.status === "waitlisted") {
      const card = this.joinReceiptCard({
        title: "候补登记",
        body: `已进入候补 · 第 ${outcome.position} 位`,
        activity,
        ticket,
        ...(showFullReceipt ? { profile } : {}),
      });
      if (dmOnly) {
        const delivered = await this.deliverSilentReceipt(card, userId, groupId);
        return delivered
          ? this.silentReceiptResult(card, silent)
          : this.silentFallbackCard(groupId ?? "", userId);
      }
      return { ok: true, text: card.text, rich: card };
    }
    // 报名恰好满员 → 在所有绑定群广播一次「已满」卡（每个群只发一次）
    if (outcome.becameFull) {
      await this.announceActivityFull(activity.activityId);
    }
    const card = this.joinReceiptCard({
      title: "报名成功",
      body: `报名成功 · 当前 ${ticket}`,
      activity,
      ticket,
      ...(showFullReceipt ? { profile } : {}),
    });
    if (dmOnly) {
      const delivered = await this.deliverSilentReceipt(card, userId, groupId);
      return delivered
        ? this.silentReceiptResult(card, silent)
        : this.silentFallbackCard(groupId ?? "", userId);
    }
    return { ok: true, text: card.text, rich: card };
  }

  /**
   * 报名结果卡。
   *
   * - 群内静默路径（`profile` 存在）：私信卡可以含姓名 / 学号 / 班级 / 人数；
   * - 私聊原地回复 / 兜底路径：正文只写结果（不含隐私字段）。
   */
  private joinReceiptCard(input: {
    title: string;
    body: string;
    activity: Activity;
    ticket: string;
    profile?: UserProfile | undefined;
  }): RichMessage {
    const footer = [`取消报名：/activity quit ${activityCode(input.activity)}`];
    const profile = input.profile;
    if (!profile) {
      return renderCard({
        title: input.title,
        lines: [`**结果**：${escapeCardText(input.body)}`],
        footer,
      });
    }
    return renderCard({
      title: input.title,
      lines: [
        `**结果**：${escapeCardText(input.body)}`,
        `**姓名**：${escapeCardText(profile.name)}`,
        `**学号**：${escapeCardText(profile.studentId)}`,
        `**班级**：${escapeCardText(profile.className)}`,
        `**当前报名**：${input.ticket}`,
        "",
        ...footer,
      ],
    });
  }

  /**
   * 群内静默路径的私信投递（§B4）：**结果只私信给本人**。
   *
   * 返回 `true` = 私信已送达；`false` = 私信失败或没有私信通道
   * （调用方用 `silentFallbackCard` 给群内**不含结果**的兜底提示）。
   *
   * 私聊点击的回调（`dmGroupId` 为空）本来就不该走静默路径，调用方会原地回复。
   */
  private async deliverSilentReceipt(
    card: RichMessage,
    userId: string,
    dmGroupId: string | undefined,
  ): Promise<boolean> {
    const sender = this.cardSender();
    if (!sender || !dmGroupId) {
      return false;
    }
    const sent = await sender.sendToUser(userId, card);
    if (sent.ok) {
      log.info("activity receipt DM delivered", { userId });
      return true;
    }
    log.warn("activity group receipt DM failed", { userId, error: sent.detail });
    return false;
  }

  /**
   * 群内静默路径的返回值：命令路径发 `silent: true`，回调路径发 `undefined`。
   *
   * `ok` 保留业务结果（报名失败仍是 `false`，只是不在群里公开）；命令路径的
   * `text` / `rich` 只是「不落地到群聊」的容器，`silent: true` 会拦下发送。
   */
  private silentReceiptResult(
    card: RichMessage,
    commandPath: boolean,
    ok = true,
  ): CardResult | undefined {
    if (!commandPath) {
      return undefined;
    }
    return { ok, text: card.text, rich: card, silent: true };
  }

  /**
   * 群内唯一的静默例外卡片：`<@!申请人>` + 「私信发送失败，请先私聊机器人再试」。
   *
   * 正文**不含任何结果字段**（成功 / 候补 / 失败原因都不出现）。
   */
  private silentFallbackCard(replyGroupId: string, userId: string): CardResult {
    const card = renderCard({
      title: "活动",
      lines: [`<@!${userId}>`, "私信发送失败，请先私聊机器人再试"],
    });
    return { ok: false, text: card.text, rich: card };
  }

  /** 静默路径下活动不存在 / 资料服务缺失：只私信，群里不发。 */
  private async dmOnlyFailure(
    silent: boolean,
    userId: string,
    reason: string,
  ): Promise<CardResult> {
    const card = renderCard({
      title: "活动操作",
      lines: [`**结果**：${escapeCardText(reason)}`],
    });
    const sender = this.cardSender();
    if (sender) {
      await sender.sendToUser(userId, card).catch(() => undefined);
    }
    return {
      ok: false,
      text: card.text,
      rich: card,
      ...(silent ? { silent: true } : {}),
    };
  }

  /**
   * 报名失败：群里不再回执（§B4 群内静默），原因只私信。
   *
   * 私信失败时群里只提示「请先私聊机器人再试」，**绝不**把原因降级到群里
   * （原因可能包含班级/学院等个人资料）。
   */
  private async activityJoinFailure(
    groupId: string | undefined,
    userId: string,
    activity: Activity,
    reason: string,
    dmOptions?: ActivityDmOptions,
  ): Promise<CardResult | undefined> {
    const privateCard = renderCard({
      title: "报名未通过",
      lines: [
        `**活动**：${escapeCardText(activity.title)}（${activityCode(activity)}）`,
        `**原因**：${escapeCardText(reason)}`,
        "",
        `查看详情：/activity info ${activityCode(activity)}`,
      ],
    });
    // §B4：群内静默 —— 结果（含失败原因）只私信，群里一条都不发
    if (dmOptions?.dmOnly) {
      if (!groupId) {
        return { ok: false, text: privateCard.text, rich: privateCard };
      }
      const delivered = await this.deliverSilentReceipt(privateCard, userId, groupId);
      if (!delivered) {
        return this.silentFallbackCard(groupId, userId);
      }
      // 命令路径（`dmSilent`）给 `silent: true` 的卡片；回调路径给 undefined（不发言）
      return this.silentReceiptResult(privateCard, dmOptions.dmSilent, false);
    }
    const sender = this.cardSender();
    const sent = sender
      ? await sender.sendToUser(userId, privateCard)
      : { ok: false, detail: "私信通道未启用" };
    if (groupId) {
      const card = renderCard({
        title: "报名未通过",
        lines: [
          `<@!${userId}>`,
          sent.ok
            ? escapeCardText("报名未通过，原因已私信。")
            : escapeCardText("报名未通过，请先私聊机器人再试（原因只走私信）。"),
        ],
        footer: [`活动详情：/activity info ${activityCode(activity)}`],
      });
      return { ok: false, text: card.text, rich: card };
    }
    return { ok: false, text: privateCard.text, rich: privateCard };
  }

  /**
   * 取消报名（`/activity quit` 与 `cb:activity:quit` 共用）。
   *
   * - `auto` 模式：立刻递补候补第一位，并私信被递补者；
   * - `manual` 模式（默认）：名额被冻结（待释放名额 +1）；
   * - §B4：群里操作时**群内静默**，回执只私信本人（连「谁退出了」都不会出现在群里）。
   */
  private async quitActivityCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
    dmOptions?: ActivityDmOptions,
  ): Promise<CardResult | undefined> {
    const dmOnly = dmOptions?.dmOnly ?? false;
    const silent = dmOptions?.dmSilent ?? false;
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return dmOnly
        ? this.dmOnlyFailure(silent, userId, `活动不存在：${parts[2] ?? "（空短码）"}`)
        : this.activityNotFoundCard(parts[2] ?? "");
    }
    const returnCard = async (card: RichMessage): Promise<CardResult | undefined> => {
      if (dmOnly) {
        const delivered = await this.deliverSilentReceipt(card, userId, groupId);
        if (delivered) {
          return this.silentReceiptResult(card, silent);
        }
        return this.silentFallbackCard(groupId ?? "", userId);
      }
      return { ok: true, text: card.text, rich: card };
    };
    const { activity } = found;
    const registration = this.activity!.findRegistration(
      activity.activityId,
      userId,
    );
    if (!registration) {
      const card = renderCard({
        title: "取消报名",
        lines: ["**结果**：你还没有报名这个活动。"],
      });
      return returnCard(card);
    }
    const outcome = this.activity!.cancelRegistrationWithPromotion(
      registration.registrationId,
      userId,
    );
    const lines: string[] = ["**结果**：已取消报名。"];
    if (outcome.promoted && outcome.registration) {
      const total = this.activity!.listRegistrations(activity.activityId).length;
      await this.notifyPromoted(
        this.activity!.getActivity(activity.activityId),
        outcome.promoted,
        total,
      );
      lines.push("**结果**：已自动递补候补第一位（已私信通知本人）。");
    } else if (outcome.heldSlots > 0) {
      lines.push(
        `**结果**：名额已冻结，等待管理员释放（待释放名额 ${outcome.heldSlots}）。`,
      );
    }
    const fresh = this.activity!.getActivity(activity.activityId);
    lines.push(`**当前报名**：${this.activity!.listRegistrations(fresh.activityId).length}${
      fresh.capacity === undefined ? "" : ` / ${fresh.capacity}`
    }`);
    // 只有「私聊原地回复」才需要 mention；静默路径由 deliverSilentReceipt 处理落点
    const mention = dmOnly ? "" : this.mention(groupId, userId).trimEnd();
    const card = renderCard({
      title: "取消报名",
      lines: [...(mention ? [mention] : []), ...lines],
      footer: [
        `重新报名：/activity join ${activityCode(fresh)}`,
        ...(fresh.heldSlots > 0 && this.canManageActivity(userId, fresh)
          ? ["释放名额：管理卡上的「释放名额」按钮"]
          : []),
      ],
    });
    return returnCard(card);
  }

  /** 名单卡：管理者专用（非管理者回调也只得到「权限不足」卡）。 */
  private handleActivitySignups(
    userId: string,
    parts: readonly string[],
    replyGroupId?: string,
    override: { page?: number; full?: boolean } = {},
  ): CardResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return this.activityNotFoundCard(parts[2] ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("只有群管理员或活动发布者可以查看报名名单。");
    }
    const rawPage = override.page ?? parseSignupPage(parts);
    const full = override.full ?? parts.includes("full");
    const rich = this.activityCardService().signupsCard({
      ...this.activityCardInput(activity, userId),
      page: rawPage,
      full,
    });
    const mention = this.mention(replyGroupId, userId).trimEnd();
    if (!mention) {
      return { ok: true, text: rich.text, rich };
    }
    return {
      ok: true,
      text: rich.text,
      rich: { ...rich, markdown: `${mention}\n${rich.markdown}` },
    };
  }

  private handleActivityCreate(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    let targetGroupId = groupId;
    let titleParts = parts.slice(2);
    if (!targetGroupId) {
      const fromInput = this.resolveTargetGroupId(undefined, parts[2]);
      if (fromInput && parts.length > 3) {
        targetGroupId = fromInput;
        titleParts = parts.slice(3);
      }
    }
    if (!targetGroupId) {
      return {
        ok: false,
        text: "用法：群内 /activity create <标题>；私信 /activity create <群号|#群短码> <标题>",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：发布活动需要群管理员或以上权限。" };
    }
    const title = titleParts.join(" ").trim();
    if (title.length === 0) {
      return { ok: false, text: "请提供活动标题：/activity create <标题>" };
    }
    try {
      const activity = this.activity!.createActivity({
        groupId: targetGroupId,
        title,
        createdBy: userId,
        groupNumber: this.identityMap?.getGroupNumber(targetGroupId) ?? "",
      });
      // 用户确认：`/activity create` 之后直接返回**配置卡**（短码 + 全部配置按钮）
      const rich = this.activityCardService().configCard(
        this.activityCardInput(activity, userId),
      );
      return { ok: true, text: rich.text, rich };
    } catch (error) {
      return { ok: false, text: `创建失败：${formatError(error)}` };
    }
  }

  private handleActivitySet(
    userId: string,
    parts: readonly string[],
    replyGroupId?: string,
  ): CommandResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return this.activityNotFoundCard(parts[2] ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("只有群管理员或活动发布者可以修改活动。");
    }
    const field = normalize(parts[3]);
    const value = parts.slice(4).join(" ").trim();
    if (!field || value.length === 0) {
      return { ok: false, text: ACTIVITY_SET_USAGE };
    }
    const applied = this.applyActivitySetting(
      activity,
      field,
      value,
      ACTIVITY_NOTIFY_FIELDS.has(field),
    );
    if (!applied.ok) {
      return { ok: false, text: applied.text };
    }
    const updated = this.activity!.getActivity(activity.activityId);
    const rich = this.activityCardService().configCard(
      this.activityCardInput(updated, userId),
    );
    return { ok: true, text: rich.text, rich };
  }

  private async handleActivityOpen(
    userId: string,
    parts: readonly string[],
    replyGroupId?: string,
  ): Promise<CardResult>
  {
    return this.publishActivity(userId, parts[2], replyGroupId);
  }

  private async handleActivityStatus(
    userId: string,
    parts: readonly string[],
    mode: "close" | "cancel" | "open",
    replyGroupId?: string,
  ): Promise<CardResult>
  {
    if (mode === "open") {
      return this.publishActivity(userId, parts[2], replyGroupId);
    }
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return this.activityNotFoundCard(parts[2] ?? "");
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return this.activityDeniedCard("只有群管理员或活动发布者可以操作活动。");
    }
    const updated =
      mode === "close"
        ? this.activity!.closeActivity(activity.activityId)
        : this.activity!.cancelActivity(activity.activityId);
    if (mode === "cancel") {
      await this.notifyActivityCancelled(updated);
      const notified =
        this.activity!.listRegistrations(updated.activityId).length +
        this.activity!.listWaitlist(updated.activityId).length;
      return this.activityNoticeCard(
        replyGroupId,
        userId,
        `**结果**：已取消活动 ${activityCode(updated)}，已私信通知 ${notified} 位同学。`,
      );
    }
    return this.activityManageNotice(userId, updated, replyGroupId, {
      ok: true,
      text: "**结果**：已关闭报名（不再接受新的报名）。",
    });
  }

  /**
   * 命令路径的报名 / 取消报名。
   *
   * §B4：群内手输 `/activity join|quit` 时**群内静默** —— 结果私信给本人，命令返回值
   * 带 `silent: true` 让 `gatewayRunner` 跳过群回复；私聊里照常原地回复。
   */
  private async handleActivityJoin(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CardResult> {
    const result = await this.joinActivityCard(groupId, userId, parts, {
      dmOnly: groupId !== undefined,
      dmSilent: groupId !== undefined,
    });
    return result ?? this.activityUnavailableCard();
  }

  private async handleActivityQuit(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CardResult> {
    const result = await this.quitActivityCard(groupId, userId, parts, {
      dmOnly: groupId !== undefined,
      dmSilent: groupId !== undefined,
    });
    return result ?? this.activityUnavailableCard();
  }

  /**
   * 理论上不可达的兜底卡（命令路径必须给出卡片）。
   *
   * 静默路径在命令上下文中总是返回带 `silent: true` 的卡片，因此这里只在
   * 调用方误用（例如把回调路径的结果当成指令结果返回）时出现。
   */
  private activityUnavailableCard(): CardResult {
    const card = renderCard({
      title: "活动",
      lines: ["操作已完成，但结果无法投递，请私聊机器人后重试。"],
    });
    return { ok: false, text: card.text, rich: card, silent: true };
  }

  /** `/activity info <#短码>`：详情卡（回调 `cb:activity:info` 复用）。 */
  private handleActivityInfo(
    userId: string,
    code: string | undefined,
  ): CardResult {
    return this.activityInfoCard(userId, code);
  }

  private formatActivityList(groupId: string): string {
    const activities = this.activity!.listActivities(groupId);
    if (activities.length === 0) {
      return `群 ${this.displayGroup(groupId)} 还没有活动。\n\n${ACTIVITY_USAGE}`;
    }
    const lines = [`群 ${this.displayGroup(groupId)} 的活动：`];
    for (const activity of activities) {
      const count = this.activity!.listRegistrations(activity.activityId).length;
      lines.push(
        `- ${activityCode(activity)} ${activity.title} [${activity.status}] 报名 ${count}${
          activity.capacity ? `/${activity.capacity}` : ""
        }`,
      );
    }
    lines.push("", `查看详情：/activity info <活动短码>`);
    return lines.join("\n");
  }

  private formatActivityInfo(activity: Activity): string
  {
    const rich = this.activityCardService().configCard(
      this.activityCardInput(activity, activity.createdBy),
    );
    return rich.text;
  }

  private handlePending(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    return this.pendingCard(groupId, userId, parts);
  }

  private async handleApprove(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const resolved = this.resolveReviewTarget(groupId, parts);
    const { targetGroupId, requestId } = resolved;
    if (!targetGroupId || !requestId) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "  /approve <#申请短码>                         群内审批本群\n" +
          "  /approve <群号|#群短码> <#申请短码>            私信中审批指定群\n" +
          "  /approve <#申请短码>                         私信中也可以（自动定位该申请所属群）",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        return { ok: false, text: "申请不属于该群。" };
      }
      await this.joinApproval.approve(targetGroupId, requestId, userId);
    } catch (error) {
      log.warn("approve failed", { requestId, error: formatError(error) });
      return { ok: false, text: `审批失败：${formatError(error)}` };
    }
    log.info("approved join request", { requestId, userId });
    return this.approvalResultCard(
      targetGroupId,
      userId,
      `已通过入群申请 ${this.displayRequest(requestId)}。`,
      true,
      groupId,
    );
  }

  private async handleReject(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const { targetGroupId, requestId, reasonParts } = this.resolveReviewTarget(
      groupId,
      parts,
    );
    if (!targetGroupId || !requestId) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "  /reject <#申请短码> [原因]                    群内审批本群\n" +
          "  /reject <群号|#群短码> <#申请短码> [原因]      私信中审批指定群\n" +
          "  /reject <#申请短码> [原因]                    私信中也可以（自动定位该申请所属群）",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    const reason = reasonParts.join(" ").trim();
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        return { ok: false, text: "申请不属于该群。" };
      }
      await this.joinApproval.reject(targetGroupId, requestId, userId, reason);
    } catch (error) {
      log.warn("reject failed", { requestId, error: formatError(error) });
      return { ok: false, text: `审批失败：${formatError(error)}` };
    }
    log.info("rejected join request", {
      requestId,
      userId,
      hasReason: reason.length > 0,
    });
    return this.approvalResultCard(
      targetGroupId,
      userId,
      `已拒绝入群申请 ${this.displayRequest(requestId)}。`,
      true,
      groupId,
    );
  }

  private async handleRules(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const action = normalize(parts[1]);
    if (action === "set" || action === "设置") {
      return this.handleRulesSet(groupId, userId, parts);
    }
    if (action === "add" || action === "新增" || action === "加") {
      return this.handleRulesKeywordAdd(groupId, userId, parts);
    }
    if (action === "del" || action === "delete" || action === "删除") {
      return this.handleRulesKeywordDelete(groupId, userId, parts);
    }
    if (action === "overrides" || action === "覆盖") {
      const { page } = extractPageToken(parts.slice(1));
      return this.ruleOverridesCard(userId, page);
    }
    return this.rulesCard(groupId, userId, parts);
  }

  /**
   * `/rules add keyword <词>`：逐条追加关键词（权限同 `/rules set`）。
   *
   * 去重、trim、单条 ≤ {@link RULE_KEYWORD_MAX_LENGTH} 字；目标群解析与 `/rules set` 一致。
   */
  private async handleRulesKeywordAdd(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const target = this.resolveRuleTarget(groupId, parts);
    if (!target.ok) {
      return { ok: false, text: target.text };
    }
    if (!this.permissions.canManageRules(userId, target.groupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    const { field, value } = target;
    if (field !== "keyword" && field !== "keywords" && field !== "关键词") {
      return { ok: false, text: RULES_ADD_USAGE };
    }
    const keyword = value.trim();
    if (keyword.length === 0) {
      return { ok: false, text: RULES_ADD_USAGE };
    }
    if (keyword.length > RULE_KEYWORD_MAX_LENGTH) {
      return {
        ok: false,
        text: `关键词单条不能超过 ${RULE_KEYWORD_MAX_LENGTH} 个字符。`,
      };
    }
    const config = this.configStore.get(target.groupId);
    if (config.keywords.includes(keyword)) {
      return {
        ok: false,
        text: `关键词已存在：${keyword}`,
      };
    }
    const next = [...config.keywords, keyword];
    this.configStore.setOverride({ groupId: target.groupId, keywords: next });
    log.info("rule keyword added", { targetGroupId: target.groupId, keyword, userId });
    const base =
      target.groupId === DEFAULT_GROUP_ID
        ? "已更新全局规则"
        : "已更新群规则";
    return {
      ok: true,
      text: `${base}。\n\n${this.formatRules(target.groupId)}`,
    };
  }

  /**
   * `/rules del keyword <词>`：逐条删除关键词（权限同 `/rules set`）。
   *
   * 不存在时明确报错，不静默成功。
   */
  private async handleRulesKeywordDelete(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const target = this.resolveRuleTarget(groupId, parts);
    if (!target.ok) {
      return { ok: false, text: target.text };
    }
    if (!this.permissions.canManageRules(userId, target.groupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    const { field, value } = target;
    if (field !== "keyword" && field !== "keywords" && field !== "关键词") {
      return { ok: false, text: RULES_DEL_USAGE };
    }
    const keyword = value.trim();
    if (keyword.length === 0) {
      return { ok: false, text: RULES_DEL_USAGE };
    }
    const config = this.configStore.get(target.groupId);
    if (!config.keywords.includes(keyword)) {
      return { ok: false, text: `关键词不存在：${keyword}` };
    }
    const next = config.keywords.filter((item) => item !== keyword);
    this.configStore.setOverride({ groupId: target.groupId, keywords: next });
    log.info("rule keyword deleted", {
      targetGroupId: target.groupId,
      keyword,
      userId,
    });
    const base =
      target.groupId === DEFAULT_GROUP_ID
        ? "已更新全局规则"
        : "已更新群规则";
    return {
      ok: true,
      text: `${base}。\n\n${this.formatRules(target.groupId)}`,
    };
  }

  /**
   * `/rules add|del keyword` 的目标解析：与 `/rules set` 相同的「群内 / 私信带群号 / all」规则。
   *
   * 私信：`/rules add <群号|#群短码> keyword <词>`；
   * 全局：`/rules add all keyword <词>`。
   */
  private resolveRuleTarget(
    groupId: string | undefined,
    parts: readonly string[],
  ): { ok: true; groupId: string; field: string; value: string } | { ok: false; text: string } {
    const args = parts.slice(2);
    if (isGlobalTarget(args[0])) {
      return { ok: true, groupId: DEFAULT_GROUP_ID, field: args[1] ?? "", value: args.slice(2).join(" ") };
    }
    if (groupId) {
      return { ok: true, groupId, field: args[0] ?? "", value: args.slice(1).join(" ") };
    }
    const targetGroupId = this.resolveTargetGroupId(undefined, args[0]);
    if (!targetGroupId) {
      return {
        ok: false,
        text: "私信中需要提供已绑定的群号或 #群短码：/rules add <群号|#群短码> keyword <词>",
      };
    }
    return {
      ok: true,
      groupId: targetGroupId,
      field: args[1] ?? "",
      value: args.slice(2).join(" "),
    };
  }

  /** 全局规则：仅超级管理员可查看。 */
  private handleGlobalRulesView(userId: string): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: GLOBAL_RULES_DENIED };
    }
    return { ok: true, text: this.formatGlobalRules() };
  }

  private async handleRulesSet(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const args = parts.slice(2);
    if (isGlobalTarget(args[0])) {
      return this.handleGlobalRulesSet(userId, args.slice(1));
    }

    const targetGroupId = groupId ?? this.resolveTargetGroupId(undefined, args[0]);
    const field = groupId ? args[0] : args[1];
    const valueParts = groupId ? args.slice(1) : args.slice(2);

    if (!targetGroupId) {
      return {
        ok: false,
        text: "私信中设置规则需要提供已绑定的群号或 #群短码。用法：/rules set <群号|#群短码> <字段> <值>",
      };
    }
    if (!this.permissions.canManageRules(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    if (!field || valueParts.length === 0) {
      return { ok: false, text: RULES_SET_USAGE };
    }

    const value = valueParts.join(" ").trim();
    let override: GroupConfigOverride;
    try {
      override = parseRuleSetting(targetGroupId, field, value, this.configStore);
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }

    this.configStore.setOverride(override);
    log.info("group rules updated", {
      groupId: targetGroupId,
      userId,
      field: normalize(field),
    });
    return {
      ok: true,
      text: `已更新群规则。\n\n${this.formatRules(targetGroupId)}`,
    };
  }

  /** 全局规则：仅超级管理员可修改。 */
  private async handleGlobalRulesSet(
    userId: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: GLOBAL_RULES_DENIED };
    }
    const field = args[0];
    const valueParts = args.slice(1);
    if (!field || valueParts.length === 0) {
      return { ok: false, text: GLOBAL_RULES_SET_USAGE };
    }

    const value = valueParts.join(" ").trim();
    let override: GroupConfigOverride;
    try {
      override = parseRuleSetting(DEFAULT_GROUP_ID, field, value, this.configStore);
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }

    this.configStore.setOverride(override);
    log.info("global rules updated", { userId, field: normalize(field) });
    return {
      ok: true,
      text: `已更新全局规则（影响所有未单独覆盖的群）。\n\n${this.formatGlobalRules()}`,
    };
  }

  private formatRules(targetGroupId: string): string {
    return formatEffectiveConfig(
      this.configStore.get(targetGroupId),
      `群 ${this.displayGroup(targetGroupId)} 规则配置：`,
    );
  }

  private formatGlobalRules(): string {
    return formatEffectiveConfig(
      this.configStore.default,
      "全局默认规则（未单独配置的群继承）：",
    );
  }

  private handleAudit(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const { page, rest } = extractPageToken(parts);
    const targetGroupId = this.resolveTargetGroupId(groupId, rest[0]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "审计记录",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/audit [群号|#群短码] [每页数量] [+页码]",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const limit = clampLimit(groupId !== undefined ? rest[0] : rest[1]);
    return this.auditCard(targetGroupId, userId, page, limit);
  }

  private handleStatus(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    return this.statusCard(groupId, userId, parts);
  }

  private handleTest(groupId: string | undefined, userId: string): CommandResult {
    return this.testCard(groupId, userId);
  }
}


export type { CardResult, CommandResult } from "./commands/support.js";
