import type { CardResult, CommandResult } from "../commands/support.js";
import { aliasCard } from "../commands/aliasCommands.js";
import { whoisCard } from "../commands/whoisCommands.js";
import { handleProfile } from "../commands/profileCommands.js";
import { handleTestAt, handleTestMenu } from "../commands/testCommands.js";
import {
  handleNotify,
  notifyCard,
  notifyTestCard,
  notifyToggleCard,
} from "../commands/notifyCommands.js";
import type { AdminCommandContext, CommandHelpers } from "../commands/context.js";
import {
  ActivityStatus,
  PermissionLevel,
  PlatformLevel,
} from "../../core/enums.js";
import {
  appVersion,
  formatBytes,
  formatUptime,
  processStartedAt,
} from "../../core/buildInfo.js";
import { formatDisplayTime } from "../../core/timeFormat.js";
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
  parsePunishActions,
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
} from "../commands/support.js";

const log = getLogger("status-commands");

/**
 * `/status` 状态总览卡（群 / 用户 / 待审批 / 全量消息模式 + 刷新与入口按钮），
 * 底部追加一行**进程精简信息**；`/status proc` 出进程全套详情（仅全局超管）。
 */

/** 数据库目标的展示写法（postgres 只显示 host/db，**不打印 URL 里的口令**）。 */
function databaseLabel(
  settings: DiagnosticsSettings,
  detail: boolean,
): string {
  const target = settings.databaseTarget;
  if (target.driver === "memory") {
    return "memory（不落盘）";
  }
  if (target.driver === "sqlite") {
    return detail ? `sqlite · ${target.path}` : "sqlite";
  }
  try {
    const url = new URL(target.url);
    const where = `${url.hostname}${url.pathname}`;
    return detail ? `postgres · ${where}（口令已隐藏）` : "postgres";
  } catch {
    return detail ? "postgres（URL 解析失败，已隐藏）" : "postgres";
  }
}

type DiagnosticsSettings = NonNullable<
  AdminCommandContext["diagnostics"]
>["settings"];

/** 运行模式：与 `runtime.mode` 同一判据（有凭据 = official）。 */
function runtimeModeLabel(settings: DiagnosticsSettings): string {
  const mode =
    settings.qqBotAppId.length > 0 && settings.qqBotClientSecret.length > 0
      ? "official"
      : "fake";
  return `${mode} · 事件通道 ${settings.eventMode}`;
}

/** 群状态卡底部那行精简进程信息。 */
export function processSummaryLine(ctx: AdminCommandContext): string {
  const uptime = formatUptime(process.uptime() * 1000);
  const memory = formatBytes(process.memoryUsage().rss);
  const parts = [`v${appVersion()}`, `已运行 ${uptime}`, `内存 ${memory}`];
  if (ctx.diagnostics) {
    parts.push(runtimeModeLabel(ctx.diagnostics.settings));
    parts.push(databaseLabel(ctx.diagnostics.settings, false));
  }
  return `**进程**：${parts.join(" · ")}`;
}

/** 进程全套详情（`/status proc`，仅全局超管）。 */
function processDetailLines(ctx: AdminCommandContext): string[] {
  const mem = process.memoryUsage();
  const lines = [
    `**版本**：v${appVersion()}`,
    `**启动**：${formatDisplayTime(processStartedAt())}（已运行 ${formatUptime(
      process.uptime() * 1000,
    )}）`,
    `**运行时**：Node ${process.version} · PID ${process.pid} · ${process.platform}/${process.arch}`,
    `**内存**：RSS ${formatBytes(mem.rss)} · 堆 ${formatBytes(
      mem.heapUsed,
    )} / ${formatBytes(mem.heapTotal)} · 外部 ${formatBytes(mem.external)}`,
    `**待审批**：${ctx.joinAudit.pendingCount()} 条（全局）`,
  ];
  const diagnostics = ctx.diagnostics;
  if (!diagnostics) {
    lines.push("**运行配置**：（未装配诊断依赖，只有进程自身信息）");
    return lines;
  }
  const settings = diagnostics.settings;
  const notify = ctx.notifications?.stats();
  const queue = diagnostics.writeQueue;
  lines.push(
    `**运行模式**：${runtimeModeLabel(settings)}`,
    `**数据库**：${databaseLabel(settings, true)}`,
    `**写队列**：待写 ${queue.pending} · 失败 ${queue.failures} · 最近错误 ${
      queue.lastError ?? "（无）"
    }`,
    `**通知**：订阅 ${notify ? notify.subscribers : "未知"} 人 · 投递记录 ${
      notify ? notify.deliveries : "未知"
    } 条`,
    `**日志**：级别 ${settings.logLevel} · 控制台 ${
      settings.logConsole ? "开" : "关"
    } · 时区 ${settings.displayTimezone}`,
    `**保留**：原文 ${settings.rawMessageRetentionDays} 天 · 审计 ${
      settings.auditLogRetentionDays
    } 天 · 待审批有效期 ${settings.joinRequestTtlDays} 天`,
    `**菜单**：首次推送 ${settings.menuFirstPush} · 管理员 ${settings.adminUserIds.length} 人`,
  );
  return lines;
}

/** `/status proc`：进程全套详情（仅全局超管）。 */
export function processCard(
  ctx: AdminCommandContext,
  userId: string,
): CardResult {
  if (
    !ctx.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin)
  ) {
    const card = renderCard({
      title: "权限不足",
      lines: ["进程详情只有全局超管可以查看。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  return cardFromText("进程状态", processDetailLines(ctx).join("\n"), {
    rows: [
      [
        viewButton("refresh", "刷新", "status", "proc"),
        viewButton("help", "指令帮助", "help", "home"),
      ],
    ],
    footer: ["仅全局超管可见；群维度的配置看 /status。"],
  });
}

export function statusCard(
  ctx: AdminCommandContext,
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CardResult {
    const targetGroupId = ctx.helpers.resolveTargetGroupId(groupId, parts[1]);
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
    if (
      !ctx.permissions.meetsInGroup(userId, targetGroupId, PermissionLevel.Moderator)
    ) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const config = ctx.configStore.get(targetGroupId);
    const text = [
      `群 ${ctx.helpers.displayGroup(targetGroupId)} 状态：`,
      `机器人启用：${config.enabled}`,
      `消息过滤：${config.wordFilterEnabled}`,
      `全量消息模式：${ctx.groupMessageMode?.get(targetGroupId) ?? "unknown"}`,
      `入群审核：${config.joinAuditEnabled}`,
      `导出功能：${config.exportEnabled}`,
      `禁言时长：${config.muteDurationSeconds} 秒`,
      "",
      processSummaryLine(ctx),
    ].join("\n");
    const isSuperAdmin = ctx.permissions.meetsGlobal(
      userId,
      PlatformLevel.GlobalSuperAdmin,
    );
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
          ...(isSuperAdmin
            ? [viewButton("proc", "进程", "status", "proc")]
            : []),
        ],
      ],
      footer: [`本群：${ctx.helpers.displayGroup(targetGroupId)}`],
    });
  }

/** `/status` 的指令入口（回调 renderer 也走它）。 */
export function handleStatus(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): CommandResult {
  const arg = (parts[1] ?? "").trim().toLowerCase();
  if (
    arg === "proc" ||
    arg === "进程" ||
    arg === "sys" ||
    arg === "诊断" ||
    arg === "full"
  ) {
    return processCard(ctx, userId);
  }
  return statusCard(ctx, groupId, userId, parts);
}
