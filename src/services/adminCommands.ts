import type { CardResult, CommandResult } from "./commands/support.js";
import { cardify, cardifyAsync, ensureCard, mention, renderNotice } from "./commands/support.js";
import {
  displayGroup,
  displayRequest,
  displayUser,
  displayUsers,
} from "./commands/displayHelpers.js";
import { aliasCard } from "./commands/aliasCommands.js";
import { whoisCard } from "./commands/whoisCommands.js";
import { handleProfile } from "./commands/profileCommands.js";
import { handleHelp, helpCard } from "./commands/helpCommands.js";
import {
  approveCard,
  auditCard,
  handleApprove,
  handleAudit,
  handlePending,
  handleReject,
  pendingCard,
  syncCard,
} from "./commands/reviewCommands.js";
import { handleBind } from "./commands/bindCommands.js";
import {
  handleMyPermission,
  handlePermissionConfig,
  handleSync,
} from "./commands/permCommands.js";
import {
  mainMenu,
  menuContext,
  menuMessage,
  unknownCommandResult,
} from "./commands/menuCommands.js";
import { resolveTargetGroupId } from "./commands/targetResolvers.js";
import {
  handleTest,
  handleTestAt,
  handleTestMenu,
  testCard,
} from "./commands/testCommands.js";
import {
  activityCallbackCard,
  activityListCard,
  activityMemberCard,
  handleActivity,
} from "./commands/activityCommands.js";
import { handleStatus, statusCard } from "./commands/statusCommands.js";
import {
  handleNotify,
  notifyCard,
  notifyTestCard,
  notifyToggleCard,
} from "./commands/notifyCommands.js";
import type { AdminCommandContext, CommandHelpers } from "./commands/context.js";
import { ActivityStatus } from "../core/enums.js";
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
/** 关键词单条上限（与卡片标准一致：太长会挤爆按钮）。 */
const RULE_KEYWORD_MAX_LENGTH = 50;
import {
  buildMenu,
  findMenuSection,
  type MenuContext,
} from "./menu.js";
import type { RichMessage, RichMessageSender } from "./richMessages.js";
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
    return ensureCard(command, result, groupId);
  }

  /**
   * 结果反馈里的操作人提及：**群内**用 QQ 提及单独一行（`<@!userId>`），私聊不显示
   * （私聊里操作人就是接收者本人）。提及必须原样输出，不能做 markdown 转义。
   */
  private mention(replyGroupId: string | undefined, userId: string): string {
    return mention(replyGroupId, userId);
  }

  /**
   * 把反馈文案渲染成卡片行：如果第一行是提及（`<@!...>`），保持它单独成行且不转义，
   * 其余内容作为「**结果**：…」展示。
   */
  private renderNotice(notice: string | undefined): string[] {
    return renderNotice(notice);
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
    footer?: readonly string[],
    buttonHint?: string,
  ): CardResult {
    return cardify(title, result, rows, footer, buttonHint);
  }

  /** 领域子模块共享依赖（R1 拆分）：门面只负责组装，业务在 commands/* 里。 */
  private context(): AdminCommandContext {
    const helpers: CommandHelpers = {
      cardify: (title, result, rows, footer, buttonHint) =>
        this.cardify(
          title,
          result,
          rows,
          footer ?? ["按钮不可用时可直接输入指令。"],
          buttonHint ?? "相关入口：",
        ),
      renderNotice: (notice) => this.renderNotice(notice),
      mention: (replyGroupId, userId) => this.mention(replyGroupId, userId),
      displayUser: (officialId) => this.displayUser(officialId),
      displayGroup: (groupId) => this.displayGroup(groupId),
      displayRequest: (requestId) => this.displayRequest(requestId),
      displayUsers: (ids) => this.displayUsers(ids),
      groupLabel: (groupId) => this.groupLabel(groupId),
      resolveTargetGroupId: (groupId, raw) =>
        this.resolveTargetGroupId(groupId, raw),
      cardSender: () => this.cardSender(),
      roster: () => this.activityRoster,
      statsService: () => this.activityStatsService,
      exportService: () => this.activityExportService,
      fallbackSubscriptions: this.fallbackSubscriptions,
    };
    return {
      helpers,
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
      activityNotifications: this.activityNotifications,
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
        return handleHelp(this.context(), groupId, userId, parts);
      case "menu":
      case "菜单":
        return this.handleMenu(groupId, userId, parts);
      case "myperm":
      case "我的权限":
        return this.cardify(
          "我的权限",
          handleMyPermission(this.context(), groupId, userId),
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
        return cardifyAsync(
          "绑定",
          handleBind(this.context(), groupId, userId, parts),
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
        return whoisCard(this.context(), groupId, userId, parts);
      case "perm":
      case "权限":
        return this.cardify(
          "权限配置",
          handlePermissionConfig(this.context(), groupId, userId, parts),
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
        return handlePending(this.context(), groupId, userId, parts);
      case "sync":
      case "同步":
        return handleSync(this.context(), groupId, userId, parts);
      case "notify":
      case "push":
      case "推送":
      case "订阅":
        return handleNotify(this.context(), groupId, userId, parts);
      case "profile":
      case "资料":
        return this.cardify(
          "个人资料",
          handleProfile(this.context(), userId, parts),
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
        return handleActivity(this.context(), groupId, userId, parts);
      case "approve":
      case "通过":
        return handleApprove(this.context(), groupId, userId, parts);
      case "reject":
      case "拒绝":
        return handleReject(this.context(), groupId, userId, parts);
      case "rules":
      case "规则":
        return this.handleRules(groupId, userId, parts);
      case "audit":
      case "日志":
        return handleAudit(this.context(), groupId, userId, parts);
      case "status":
      case "状态":
        return handleStatus(this.context(), groupId, userId, parts);
      case "test":
      case "测试":
        return handleTest(this.context(), groupId, userId);
      case "testmenu":
        return handleTestMenu(this.context(), userId, parts);
      case "testat":
      case "@测试":
        return handleTestAt(this.context(), groupId, userId, parts);
      default:
        return this.unknownCommandResult(groupId, userId, parts[0]);
    }
  }

  private resolveTargetGroupId(
    groupId: string | undefined,
    input: string | undefined,
  ): string | undefined {
    return resolveTargetGroupId(this.context(), groupId, input);
  }

  /** 申请参数：`#短码`（推荐）或完整 join_request_id。 */
  /**
   * `/help` 列出有权限执行的指令；`/help <主题>` 展示该指令的详细用法。
   *
   * 主题详情同样做权限过滤：无权限时只提示所需权限，不展示具体命令，
   * 与「/help 只显示有权限执行的指令」保持一致。
   */
  /** 主菜单富消息（首次私信推送与未知指令回复复用）。 */
  public mainMenu(groupId: string | undefined, userId: string): RichMessage {
    return mainMenu(this.context(), groupId, userId);
  }

  /** 回调 renderer 用：渲染菜单的某一级（`cb:menu:open:<section>`）。 */
  public menuMessage(
    section: string | undefined,
    groupId: string | undefined,
    userId: string,
  ): RichMessage {
    return menuMessage(this.context(), section, groupId, userId);
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
    return helpCard(this.context(), groupId, userId, topicQuery);
  }

  /** `/status <群号|#群短码>`：运行状态卡 + 常用入口。 */
  public statusCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CardResult {
    return statusCard(this.context(), groupId, userId, parts);
  }

  public pendingCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
    notice?: string,
  ): CardResult {
    return pendingCard(this.context(), groupId, userId, parts, notice);
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
    return approveCard(this.context(), targetGroupId, requestId, userId, page, replyGroupId);
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
    return activityListCard(this.context(), targetGroupId, userId, page, notice);
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
    return notifyCard(this.context(), groupId, userId, notice);
  }

  public async notifyToggleCard(
    scope: string,
    enabled: boolean,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    return notifyToggleCard(this.context(), scope, enabled, userId, replyGroupId);
  }

  public async notifyTestCard(
    groupId: string | undefined,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    return notifyTestCard(this.context(), groupId, userId, replyGroupId);
  }

  public auditCard(
    targetGroupId: string,
    userId: string,
    page = 1,
    limit = 20,
  ): CardResult {
    return auditCard(this.context(), targetGroupId, userId, page, limit);
  }

  /** `/test`：自检结果卡 + 常用入口。 */
  public testCard(groupId: string | undefined, userId: string): CardResult {
    return testCard(this.context(), groupId, userId);
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
    return syncCard(this.context(), targetGroupId, userId, replyGroupId);
  }

  /** 审批结果卡（通过 / 拒绝），标明操作人并给回列表入口。 */
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
    return unknownCommandResult(this.context(), groupId, userId, command);
  }

  private menuContext(groupId: string | undefined, userId: string): MenuContext {
    return menuContext(this.context(), groupId, userId);
  }

  private groupLabel(groupId: string): string {
    return displayGroup(this.context(), groupId);
  }

  /**
   * 展示用户：QQ号 或随机短码 `#XXXXXX`。
   *
   * 没有注入 DisplayNameService 时（部分单测）回退为「绑定 QQ号 → QQ号，否则原样 id」。
   */
  private displayUser(officialId: string): string {
    return displayUser(this.context(), officialId);
  }

  /** 展示群：群号 或随机短码 `#XXXXXX`。 */
  private displayGroup(groupId: string): string {
    return displayGroup(this.context(), groupId);
  }

  /** 展示申请：短码 `#XXXXXX`（替代又长又难读的 join_request_id）。 */
  private displayRequest(requestId: string): string {
    return displayRequest(this.context(), requestId);
  }

  private displayUsers(ids: readonly string[]): string {
    return displayUsers(this.context(), ids);
  }

  /** 同步补齐的申请也推送一次；投递表保证同一申请不会重复推给同一个人。 */
  // ------------------------------------------------------------- /profile

  /**
   * 活动通知服务未装配时的兜底（内存记录）。
   *
   * `cb:activity:subscribe:<群ID>` 只有「当前是否订阅」这一个状态，兜底表只为它而存在；
   * 正式的推送与持久化由 `ActivityNotificationService` 负责（见 runtime 装配）。
   */
  private readonly fallbackSubscriptions = new Set<string>();

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

  public activityMemberCard(activity: Activity, viewerId: string): RichMessage {
    return activityMemberCard(this.context(), activity, viewerId);
  }

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
    return activityCallbackCard(this.context(), action, args, userId, replyGroupId);
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

  private handleTest(groupId: string | undefined, userId: string): CommandResult {
    return handleTest(this.context(), groupId, userId);
  }
}

export type { CardResult, CommandResult } from "./commands/support.js";
