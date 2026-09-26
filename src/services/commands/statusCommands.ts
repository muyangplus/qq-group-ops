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
} from "../commands/support.js";

const log = getLogger("status-commands");

/**
 * /status 状态总览卡（群 / 用户 / 待审批 / 全量消息模式 + 刷新与入口按钮）。
 */

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
    if (!ctx.permissions.canReviewContent(userId, targetGroupId)) {
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
  return statusCard(ctx, groupId, userId, parts);
}
