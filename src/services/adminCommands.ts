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
import { handleMyPermission, handlePermissionConfig, handleSync } from "./commands/permCommands.js";
import {
  mainMenu,
  menuContext,
  menuMessage,
  unknownCommandResult,
} from "./commands/menuCommands.js";
import { resolveTargetGroupId } from "./commands/targetResolvers.js";
import { handleTest, handleTestAt, handleTestMenu, testCard } from "./commands/testCommands.js";
import {
  activityCallbackCard,
  handleActivity,
} from "./commands/activityCommands.js";
import {
  activityListCard,
  activityMemberCard,
} from "./commands/activityCardCommands.js";
import {
  clearKeywordsCard,
  delKeywordCard,
  handleRules,
  resetAllRulesCard,
  resetRulePageCard,
  rosterToggleCard,
  ruleOverridesCard,
  rulesCard,
  rulesPanelCard,
  toggleRulesCard,
} from "./commands/ruleCommands.js";
import { handleStatus, statusCard } from "./commands/statusCommands.js";
import {
  handleNotify,
  notifyCard,
  notifyPunishCard,
  notifyPunishTestCard,
  notifyPunishToggleCard,
  notifyTestCard,
  notifyToggleCard,
} from "./commands/notifyCommands.js";
import {
  blacklistCard,
  blacklistDeleteCard,
  blacklistScopeCard,
  handleBlacklist,
} from "./commands/blacklistCommands.js";
import { handlePunish, punishCallbackCard } from "./commands/punishCommands.js";
import { appealCallbackCard, handleAppeal } from "./commands/appealCommands.js";
import type { AdminCommandContext, CommandHelpers } from "./commands/context.js";
import type { CardButton } from "./cardTemplate.js";
import { getLogger } from "../core/logger.js";
import type { AuditLog } from "./audit.js";
import { ActivityCardService } from "./activityCards.js";
import type { ActivityExportLike, ActivityStatsLike } from "./activityCards.js";
import type { Activity, ActivityService } from "./activity.js";
import type { ActivityNotificationService } from "./activityNotifications.js";
import type { AppealService } from "./appeals.js";
import type { BlacklistService } from "./blacklist.js";
import type { DisplayNameService } from "./displayNames.js";
import type { MemberRoster } from "./memberRoster.js";
import type { ModerationNotifier } from "./moderationNotifier.js";
import type { PunishmentService } from "./punishments.js";
import type { GroupConfigStore } from "./groupConfig.js";
/** 关键词单条上限（与卡片标准一致：太长会挤爆按钮）。 */
import { buildMenu, findMenuSection, type MenuContext } from "./menu.js";
import type { RichMessage, RichMessageSender } from "./richMessages.js";
import type { JoinRuleEvaluator } from "./joinRules.js";
import type { GroupMessageModeRegistry } from "./groupMessageMode.js";
import type { IdentityMapService } from "./identityMap.js";
import type { JoinApprovalService } from "./joinApproval.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { JoinRequestSyncService } from "./joinAuditSync.js";
import type { ClassAliasService } from "./classAliases.js";
import type { NotificationService } from "./notifications.js";
import type { PermissionService } from "./permissions.js";
import type { UserProfileService } from "./userProfiles.js";

import { viewButton } from "./commands/support.js";
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

  /** §A5 黑名单（本群 / 全局）。 */
  blacklist?: BlacklistService | undefined;

  /** §B7 处罚记录与卡片动作。 */
  punishments?: PunishmentService | undefined;

  /** §B8 申诉记录。 */
  appeals?: AppealService | undefined;

  /** 处罚 / 申诉的私信卡片渲染与推送。 */
  moderationNotifier?: ModerationNotifier | undefined;

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

  private readonly blacklist: BlacklistService | undefined;

  private readonly punishments: PunishmentService | undefined;

  private readonly appeals: AppealService | undefined;

  private readonly moderationNotifier: ModerationNotifier | undefined;

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
    this.blacklist = options.blacklist;
    this.punishments = options.punishments;
    this.appeals = options.appeals;
    this.moderationNotifier = options.moderationNotifier;
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

    // 申诉是隐私动作，且被处罚的人可能还没绑定 QQ 号，因此豁免绑定检查
    const bindingExempt = new Set([
      "help",
      "帮助",
      "bind",
      "绑定",
      "menu",
      "菜单",
      "appeal",
      "申诉",
    ]);
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
      blacklist: this.blacklist,
      punishments: this.punishments,
      appeals: this.appeals,
      moderationNotifier: this.moderationNotifier,
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
      case "blacklist":
      case "black":
      case "黑名单":
        return handleBlacklist(this.context(), groupId, userId, parts);
      case "punish":
      case "处罚":
        return handlePunish(this.context(), groupId, userId, parts);
      case "appeal":
      case "申诉":
        return handleAppeal(this.context(), groupId, userId, parts);
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
        return handleRules(this.context(), groupId, userId, parts);
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
    return rulesCard(this.context(), groupId, userId, parts, notice);
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
    return rulesPanelCard(this.context(), panel, targetGroupId, userId, notice, page, mode);
  }

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
    return toggleRulesCard(this.context(), targetGroupId, field, value, userId, panel, replyGroupId, page, mode);
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
    return delKeywordCard(this.context(), targetGroupId, serial, page, userId, replyGroupId);
  }

  public clearKeywordsCard(
    targetGroupId: string,
    userId: string,
    replyGroupId?: string,
  ): CardResult {
    return clearKeywordsCard(this.context(), targetGroupId, userId, replyGroupId);
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
    return resetRulePageCard(this.context(), targetGroupId, panel, rawFields, userId, replyGroupId, page, mode);
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
    return resetAllRulesCard(this.context(), targetGroupId, userId, replyGroupId);
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
    return rosterToggleCard(this.context(), targetGroupId, field, mode, option, userId, replyGroupId, page);
  }

  /**
   * 回调：全局规则覆盖率总览（`cb:rules:overrides:<页>`）。
   *
   * 每页 10 个群，列出该群显式覆盖的字段；没有覆盖的显示「全部继承全局」。
   */
  public ruleOverridesCard(userId: string, page = 1): CardResult {
    return ruleOverridesCard(this.context(), userId, page);
  }

  /**
   * `/testmenu [页码]`：官方回调按钮翻页试验（仅全局超级管理员）。
   *
   * 卡片里的「上一页 / 下一页 / 返回」是回调按钮（`action.type=1`），
   * 点击后由 `TestMenuService` 走互动事件链路被动回复新的一页；
   * 同时保留 `/testmenu <页码>` 指令入口与「指令翻页」按钮作为双通道兜底。
   */
  /** `/menu [常用|管理|超管|活动|审核|运营]`：渲染对应层级的交互菜单。 */
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
          "用法：/menu [常用|管理|超管|活动|审核|运营]\n\n" +
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

  /** `/notify punish`：处罚事件推送订阅卡（与入群申请推送相互独立）。 */
  public notifyPunishCard(
    groupId: string | undefined,
    userId: string,
    notice?: string,
  ): CardResult {
    return notifyPunishCard(this.context(), groupId, userId, notice);
  }

  /** 回调：`cb:notify:punishToggle:<scope>:<on|off>`。 */
  public async notifyPunishToggleCard(
    scope: string,
    enabled: boolean,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    return notifyPunishToggleCard(
      this.context(),
      scope,
      enabled,
      userId,
      replyGroupId,
    );
  }

  /** 回调：`cb:notify:punishTest`。 */
  public async notifyPunishTestCard(
    groupId: string | undefined,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    return notifyPunishTestCard(this.context(), groupId, userId, replyGroupId);
  }

  /** 回调：`cb:blacklist:scope|del:*`（列表切换 / 解除，内部重新鉴权）。 */
  public blacklistScopeCard(
    scope: string,
    groupId: string,
    page: number,
    userId: string,
  ): CardResult {
    return blacklistScopeCard(this.context(), {
      scope,
      groupId,
      page,
      viewerId: userId,
    });
  }

  public async blacklistDeleteCard(
    scope: string,
    groupId: string,
    targetUserId: string,
    page: number,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    return blacklistDeleteCard(this.context(), {
      scope,
      groupId,
      targetUserId,
      page,
      viewerId: userId,
      replyGroupId,
    });
  }

  /** 回调：`cb:punish:*`（处罚卡片上的调整动作，内部重新鉴权）。 */
  public async punishCallbackCard(
    action: string,
    args: readonly string[],
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult | undefined> {
    return punishCallbackCard(this.context(), action, args, userId, replyGroupId);
  }

  /** 回调：`cb:appeal:*`（我要申诉 / 通过 / 驳回，内部重新鉴权）。 */
  public async appealCallbackCard(
    action: string,
    args: readonly string[],
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult | undefined> {
    return appealCallbackCard(this.context(), action, args, userId, replyGroupId);
  }

  private handleTest(groupId: string | undefined, userId: string): CommandResult {
    return handleTest(this.context(), groupId, userId);
  }
}

export type { CardResult, CommandResult } from "./commands/support.js";
