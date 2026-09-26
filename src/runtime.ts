import { FetchTransport } from "./adapters/fetchTransport.js";
import { FakeQQOfficialAPI } from "./adapters/fakeQqOfficial.js";
import {
  FileBotCacheStore,
  type BotCacheStore,
} from "./adapters/botCache.js";
import {
  QQOfficialClient,
  type QQOfficialAPI,
} from "./adapters/qqOfficial.js";
import { loadSettings, type Settings } from "./config.js";
import {
  instrumentQQOfficialAPI,
  instrumentTransport,
} from "./core/instrumentation.js";
import { getLogger } from "./core/logger.js";
import type { ActivityRepository } from "./db/activityRepository.js";
import type { ActivityDetailsRepository } from "./db/activityDetailsRepository.js";
import type { ActivityWaitlistRepository } from "./db/activityWaitlistRepository.js";
import type { ActivitySettingsRepository } from "./db/activitySettingsRepository.js";
import type { ActivityGroupRepository } from "./db/activityGroupRepository.js";
import type { ActivitySubscriptionRepository } from "./db/activitySubscriptionRepository.js";
import type { ActivityNotificationRepository } from "./db/activityNotificationRepository.js";
import type { AuditRepository } from "./db/auditRepository.js";
import type { BlacklistRepository } from "./db/blacklistRepository.js";
import type { PunishmentRepository } from "./db/punishmentRepository.js";
import type { AppealRepository } from "./db/appealRepository.js";
import type { GroupConfigRepository } from "./db/groupConfigRepository.js";
import type { GroupSettingsRepository } from "./db/groupSettingsRepository.js";
import type { GroupMessageModeRepository } from "./db/groupMessageModeRepository.js";
import type { IdentityBindingRepository } from "./db/identityBindingRepository.js";
import type { JoinRequestRepository } from "./db/joinRequestRepository.js";
import type { MenuDeliveryRepository } from "./db/menuDeliveryRepository.js";
import type {
  NotificationDeliveryRepository,
  NotificationSubscriptionRepository,
} from "./db/notificationRepository.js";
import type { PermissionRepository } from "./db/permissionRepository.js";
import type { ShortCodeRepository } from "./db/shortCodeRepository.js";
import type { UserProfileRepository } from "./db/userProfileRepository.js";
import type { ClassAliasRepository } from "./db/classAliasRepository.js";
import { WriteQueue } from "./db/writeQueue.js";
import { pageArg, pageTargets } from "./services/callbackData.js";
import {
  CallbackRouter,
  type CallbackRenderer,
} from "./services/callbackRouter.js";
import { ActivityService } from "./services/activity.js";
import { ActivityCardService } from "./services/activityCards.js";
import { ActivityExportService } from "./services/activityExport.js";
import { ActivityStatsService } from "./services/activityStats.js";
import { ActivityNotificationService } from "./services/activityNotifications.js";
import { AdminCommandService } from "./services/adminCommands.js";
import { AppealService } from "./services/appeals.js";
import { AuditLogStore } from "./services/audit.js";
import { BlacklistService } from "./services/blacklist.js";
import { DisplayNameService } from "./services/displayNames.js";
import { EventRouter } from "./services/eventRouter.js";
import { ExportService } from "./services/export.js";
import {
  MemoryFirstMenuPushState,
  PersistentFirstMenuPushState,
  type FirstMenuPushState,
} from "./services/firstMenuPush.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "./services/groupConfig.js";
import { GroupMessageModeRegistry } from "./services/groupMessageMode.js";
import { IdentityMapService } from "./services/identityMap.js";
import { JoinApprovalService } from "./services/joinApproval.js";
import { JoinAuditService } from "./services/joinAudit.js";
import { JoinRequestSyncService } from "./services/joinAuditSync.js";
import { JoinRuleEvaluator } from "./services/joinRules.js";
import { MemberRoster } from "./services/memberRoster.js";
import { MessageGuardService } from "./services/messageGuard.js";
import { ModerationNotifier } from "./services/moderationNotifier.js";
import { RuleEngine } from "./services/moderation.js";
import { NotificationService } from "./services/notifications.js";
import { PermissionService } from "./services/permissions.js";
import { PunishmentService } from "./services/punishments.js";
import { RichMessageSender } from "./services/richMessages.js";
import { ShortCodeService } from "./services/shortCodes.js";
import { TestMenuService } from "./services/testMenu.js";
import { UserProfileService } from "./services/userProfiles.js";
import { ClassAliasService } from "./services/classAliases.js";

export interface Runtime {
  mode: "official" | "fake";
  api: QQOfficialAPI;
  auditLog: AuditLogStore;
  joinAudit: JoinAuditService;
  configStore: GroupConfigStore;
  groupMessageMode: GroupMessageModeRegistry;
  identityMap: IdentityMapService;
  permissions: PermissionService;
  activity: ActivityService;
  activityCards: ActivityCardService;
  /** 活动通知：按群订阅 + 去重封顶的私信推送。 */
  activityNotifications: ActivityNotificationService;
  userProfiles: UserProfileService;
  classAliases: ClassAliasService;
  exportService: ExportService;
  notifications: NotificationService;
  /** §A5 黑名单（本群 / 全局）。 */
  blacklist: BlacklistService;
  /** §B7 处罚记录与卡片动作。 */
  punishments: PunishmentService;
  /** §B8 申诉记录。 */
  appeals: AppealService;
  /** 处罚 / 申诉私信卡片的渲染与推送。 */
  moderationNotifier: ModerationNotifier;
  shortCodes: ShortCodeService;
  display: DisplayNameService;
  writeQueue: WriteQueue;
  router: EventRouter;
  /** 管理员指令（gatewayRunner 用它渲染首次私信的主菜单）。 */
  adminCommands: AdminCommandService;
  /** 富消息发送器（Markdown + 按钮，含被动回复与三级降级）。 */
  richMessages: RichMessageSender;
  /** 私信首次交互主菜单的去重状态（dev 内存 / 正式入库）。 */
  menuState: FirstMenuPushState;
  /** 回调按钮翻页试验（`/testmenu`）。 */
  testMenu: TestMenuService;
  /** 从数据库载入全部持久化状态；未配置数据库时为空操作。 */
  load(): Promise<void>;
  /** 等待所有排队写入落库。 */
  flush(): Promise<void>;
}

export interface RuntimeRepositories {
  audit?: AuditRepository;
  joinRequests?: JoinRequestRepository;
  groupConfigs?: GroupConfigRepository;
  groupSettings?: GroupSettingsRepository;
  identityBindings?: IdentityBindingRepository;
  groupMessageModes?: GroupMessageModeRepository;
  permissions?: PermissionRepository;
  activities?: ActivityRepository;
  activityDetails?: ActivityDetailsRepository;
  activityWaitlist?: ActivityWaitlistRepository;
  activitySettings?: ActivitySettingsRepository;
  activitySubscriptions?: ActivitySubscriptionRepository;
  activityNotifications?: ActivityNotificationRepository;
  /** 活动绑定群（§B4）：一个活动可发布 / 广播到多个群。 */
  activityGroups?: ActivityGroupRepository;
  notificationSubscriptions?: NotificationSubscriptionRepository;
  notificationDeliveries?: NotificationDeliveryRepository;
  /** §A5 黑名单（本群 / 全局）。 */
  blacklist?: BlacklistRepository;
  /** §B7 处罚记录。 */
  punishments?: PunishmentRepository;
  /** §B8 申诉记录。 */
  appeals?: AppealRepository;
  shortCodes?: ShortCodeRepository;
  userProfiles?: UserProfileRepository;
  classAliases?: ClassAliasRepository;
  menuDeliveries?: MenuDeliveryRepository;
}

export interface RuntimeDependencies {
  repositories?: RuntimeRepositories;
}

export function createRuntime(
  settings: Settings = loadSettings(),
  dependencies: RuntimeDependencies = {},
): Runtime {
  const repositories = dependencies.repositories ?? {};
  const writeQueue = new WriteQueue();
  const api = instrumentQQOfficialAPI(createApi(settings), getLogger("runtime"));
  const richMessages = new RichMessageSender(api);
  const auditLog = new AuditLogStore(repositories.audit, writeQueue);
  const joinAudit = new JoinAuditService(
    auditLog,
    repositories.joinRequests,
    writeQueue,
  );
  // 待审批申请有效期（0 天 = 不自动过期）
  joinAudit.setPendingTtlMs(settings.joinRequestTtlDays * 24 * 60 * 60 * 1_000);
  const configStore = new GroupConfigStore(
    { groupId: DEFAULT_GROUP_ID },
    repositories.groupConfigs,
    writeQueue,
    repositories.groupSettings,
  );
  const groupMessageMode = new GroupMessageModeRegistry(
    repositories.groupMessageModes,
    writeQueue,
  );
  const identityMap = new IdentityMapService(repositories.identityBindings);
  const shortCodes = new ShortCodeService(repositories.shortCodes, writeQueue);
  const display = new DisplayNameService(identityMap, shortCodes);
  const permissions = new PermissionService(
    { superAdminIds: new Set(settings.adminUserIds) },
    repositories.permissions,
    writeQueue,
  );
  const activity = new ActivityService(
    repositories.activities,
    writeQueue,
    repositories.activityDetails,
    {
      waitlistRepository: repositories.activityWaitlist,
      settingsRepository: repositories.activitySettings,
      groupRepository: repositories.activityGroups,
    },
  );
  const activityCards = new ActivityCardService({
    activity,
    display,
    // 绑定群子卡里的群展示名：优先绑定号 / 短码，缺省显示内部群 ID
    groupLabel: (groupId) => display.group(groupId),
  });
  const testMenu = new TestMenuService({ permissions });
  const userProfiles = new UserProfileService(repositories.userProfiles, writeQueue);
  const classAliases = new ClassAliasService(
    repositories.classAliases,
    writeQueue,
  );
  const exportService = new ExportService(permissions, auditLog);
  const joinRules = new JoinRuleEvaluator();
  const joinSync = new JoinRequestSyncService(api, joinAudit);
  const notifications = new NotificationService(api, permissions, {
    subscriptions: repositories.notificationSubscriptions,
    deliveries: repositories.notificationDeliveries,
    queue: writeQueue,
    identityMap,
    display,
    configStore,
    joinRules,
    sender: richMessages,
  });
  // §A5 黑名单：本群踢人 + 官方群拉黑；全局黑名单踢出所有绑定群。
  const blacklist = new BlacklistService(api, {
    repository: repositories.blacklist,
    queue: writeQueue,
    auditLog,
    listBoundGroups: () =>
      identityMap.listGroups().map((group) => group.officialId),
  });
  // §B7/B8 处罚 / 申诉私信卡片：复用入群申请推送的发送通道与订阅表（频道 `punish`）。
  const moderationNotifier = new ModerationNotifier({
    notifications,
    permissions,
    groupLabel: (groupId) => display.group(groupId),
    userLabel: (userId) => display.user(userId),
  });
  const punishments = new PunishmentService(api, blacklist, {
    repository: repositories.punishments,
    queue: writeQueue,
    auditLog,
    notifier: moderationNotifier,
  });
  const appeals = new AppealService({
    repository: repositories.appeals,
    queue: writeQueue,
  });
  const messageGuard = new MessageGuardService(
    api,
    new RuleEngine(),
    configStore,
    auditLog,
    permissions,
    richMessages,
    punishments,
  );
  const joinApproval = new JoinApprovalService(
    api,
    joinAudit,
    configStore,
    joinRules,
    blacklist,
  );
  const activityNotifications = new ActivityNotificationService(
    notifications,
    repositories.activitySubscriptions,
    repositories.activityNotifications,
    // 满员广播是**群消息**：直接复用富消息发送器发到绑定群（不占用户私信额度）。
    {
      dailyLimit: settings.activityNotifyDailyLimit,
      ratePerSecond: settings.activityNotifyRatePerSecond,
      groupSender: richMessages,
    },
  );
  /**
   * §B3 统计图片与 CSV 导出。
   *
   * - **统计图片**：`@napi-rs/canvas` 是**可选**依赖（动态 import）。字体系统优先
   *   （Windows 雅黑 / Linux Noto CJK / macOS 苹方），找不到才从
   *   `ACTIVITY_STATS_FONT_URL` 下载并缓存到 `data/fonts/`（gitignored，不随包提交）。
   *   拿不到依赖或字体只返回 `undefined`，由 `AdminCommandService` 降级为文字统计卡
   *   —— 统计图是锦上添花，绝不能让启动或活动回调失败。
   * - **CSV 导出**：含学号/班级/学院等隐私字段，只私信给操作者本人。
   */
  const activityStats = new ActivityStatsService({
    api,
    fontUrl: settings.activityStatsFontUrl,
  });
  const activityExport = new ActivityExportService({
    sender: richMessages,
    profiles: userProfiles,
  });
  // 卡片服务与降级路径共用同一份能力判断：装配后管理卡才出现「统计图片」、
  // 名单卡才出现「导出 CSV」（条件渲染在 ActivityCardService 里）。
  activityCards.setActivityExtras({
    stats: activityStats,
    exportService: activityExport,
  });
  const adminCommands = new AdminCommandService({
    permissions,
    joinAudit,
    configStore,
    joinApproval,
    joinSync,
    auditLog,
    joinRules,
    groupMessageMode,
    identityMap,
    display,
    userProfiles,
    classAliases,
    activity,
    activityCards,
    activityNotifications,
    notifications,
    blacklist,
    punishments,
    appeals,
    moderationNotifier,
    richMessages,
    cardSender: richMessages,
  });
  const menuState = createFirstMenuPushState(
    settings,
    repositories.menuDeliveries,
    writeQueue,
  );
  // 回调 renderer 表：导航/查看类按钮点击后由此渲染新卡片（见 docs/CARD-STANDARD.md）
  const callbackRenderers = new Map<string, CallbackRenderer>([
    [
      "menu",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        // 活动层级直接用活动列表卡（带分页与操作按钮），其余层级走菜单定义
        if (parsed.args[0] === "activity" && event.groupId) {
          return adminCommands.activityListCard(event.groupId, userId, 1).rich;
        }
        return adminCommands.menuMessage(parsed.args[0], event.groupId, userId);
      },
    ],
    [
      "help",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        const topic =
          parsed.action === "topic"
            ? parsed.args[0]
            : parsed.action === "list"
              ? "all"
              : undefined;
        return adminCommands.helpCard(event.groupId, userId, topic).rich;
      },
    ],
    [
      "status",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        return adminCommands.statusCard(event.groupId, userId, [
          "status",
          ...parsed.args,
        ]).rich;
      },
    ],
    [
      "pending",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        if (parsed.action === "approve") {
          const [targetGroupId, requestId, page] = parsed.args;
          if (!targetGroupId || !requestId) {
            return undefined;
          }
          const card = await adminCommands.approveCard(
            targetGroupId,
            requestId,
            userId,
            Number.parseInt(page ?? "1", 10) || 1,
            event.groupId,
          );
          return card.rich;
        }
        return adminCommands.pendingCard(event.groupId, userId, [
          "pending",
          ...pageTargets(parsed.args),
          `+${pageArg(parsed.args) ?? 1}`,
        ]).rich;
      },
    ],
    [
      "rules",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        // 所有规则回调都在这里重新做权限校验（见 docs/CARD-STANDARD.md §5）：
        // `toggle` / `resetPage` / `resetAll` / `delKeyword` / `clearKeyword` / `rosterToggle`
        // 需要群管理员（或超管），`panel` / `all` / `overrides` 至少需要审核员（查看）；
        // 具体校验在对应方法内部完成，越权返回「权限不足」卡片。
        if (parsed.action === "toggle") {
          const [targetGroupId, field, value, panel, page, mode] = parsed.args;
          if (!targetGroupId || !field || !value) {
            return undefined;
          }
          const card = await adminCommands.toggleRulesCard(
            targetGroupId,
            field,
            value,
            userId,
            panel,
            event.groupId,
            Number.parseInt(page ?? "1", 10) || 1,
            mode === "deny" ? "deny" : "allow",
          );
          return card.rich;
        }
        if (parsed.action === "panel") {
          const [targetGroupId, panel, page, mode] = parsed.args;
          if (!targetGroupId || !panel) {
            return undefined;
          }
          return adminCommands.rulesPanelCard(
            panel,
            targetGroupId,
            userId,
            undefined,
            Number.parseInt(page ?? "1", 10) || 1,
            mode === "deny" ? "deny" : "allow",
          ).rich;
        }
        if (parsed.action === "panelPage") {
          const [targetGroupId, panel, page, mode] = parsed.args;
          if (!targetGroupId || !panel) {
            return undefined;
          }
          return adminCommands.rulesPanelCard(
            panel,
            targetGroupId,
            userId,
            undefined,
            Number.parseInt(page ?? "1", 10) || 1,
            mode === "deny" ? "deny" : "allow",
          ).rich;
        }
        if (parsed.action === "delKeyword") {
          const [targetGroupId, serial, page] = parsed.args;
          if (!targetGroupId) {
            return undefined;
          }
          return adminCommands.delKeywordCard(
            targetGroupId,
            Number.parseInt(serial ?? "0", 10),
            Number.parseInt(page ?? "1", 10) || 1,
            userId,
            event.groupId,
          ).rich;
        }
        if (parsed.action === "clearList") {
          const [targetGroupId, field] = parsed.args;
          if (!targetGroupId || !field) {
            return undefined;
          }
          return adminCommands.clearRuleListCard(
            targetGroupId,
            field,
            userId,
            event.groupId,
          ).rich;
        }
        if (parsed.action === "clearKeyword") {
          const [targetGroupId] = parsed.args;
          if (!targetGroupId) {
            return undefined;
          }
          return adminCommands.clearKeywordsCard(
            targetGroupId,
            userId,
            event.groupId,
          ).rich;
        }
        if (parsed.action === "resetPage") {
          const [targetGroupId, panel, fields, page, mode] = parsed.args;
          if (!targetGroupId || !panel || !fields) {
            return undefined;
          }
          return adminCommands.resetRulePageCard(
            targetGroupId,
            panel,
            fields,
            userId,
            event.groupId,
            Number.parseInt(page ?? "1", 10) || 1,
            mode === "deny" ? "deny" : "allow",
          ).rich;
        }
        if (parsed.action === "resetAll") {
          const [targetGroupId] = parsed.args;
          if (!targetGroupId) {
            return undefined;
          }
          return adminCommands.resetAllRulesCard(
            targetGroupId,
            userId,
            event.groupId,
          ).rich;
        }
        if (parsed.action === "rosterToggle") {
          const [targetGroupId, field, mode, option, page] = parsed.args;
          if (!targetGroupId || !field || !option) {
            return undefined;
          }
          return adminCommands.rosterToggleCard(
            targetGroupId,
            field,
            mode === "deny" ? "deny" : "allow",
            option,
            userId,
            event.groupId,
            Number.parseInt(page ?? "1", 10) || 1,
          ).rich;
        }
        if (parsed.action === "overrides") {
          return adminCommands.ruleOverridesCard(
            userId,
            Number.parseInt(parsed.args[0] ?? "1", 10) || 1,
          ).rich;
        }
        const parts =
          parsed.action === "all"
            ? ["rules", "all"]
            : ["rules", ...parsed.args];
        return adminCommands.rulesCard(event.groupId, userId, parts).rich;
      },
    ],
    [
      "audit",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        const [targetGroupId, limit, page] = parsed.args;
        if (!targetGroupId) {
          return undefined;
        }
        return adminCommands.auditCard(
          targetGroupId,
          userId,
          Number.parseInt(page ?? "1", 10) || 1,
          Number.parseInt(limit ?? "20", 10) || 20,
        ).rich;
      },
    ],
    [
      "test",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        return adminCommands.testCard(event.groupId, userId).rich;
      },
    ],
    [
      "sync",
      async (parsed, event) => {
        const userId = event.userId;
        const targetGroupId = parsed.args[0] ?? event.groupId;
        if (!userId || !targetGroupId) {
          return undefined;
        }
        const card = await adminCommands.syncCard(
          targetGroupId,
          userId,
          event.groupId,
        );
        return card.rich;
      },
    ],
    [
      "notify",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        if (parsed.action === "toggle") {
          const [scope, value] = parsed.args;
          if (!scope || (value !== "on" && value !== "off")) {
            return undefined;
          }
          const card = await adminCommands.notifyToggleCard(
            scope,
            value === "on",
            userId,
            event.groupId,
          );
          return card.rich;
        }
        if (parsed.action === "test") {
          const card = await adminCommands.notifyTestCard(
            parsed.args[0] ?? event.groupId,
            userId,
            event.groupId,
          );
          return card.rich;
        }
        // §B7 处罚通知推送（独立频道）
        if (parsed.action === "punishToggle") {
          const [scope, value] = parsed.args;
          if (!scope || (value !== "on" && value !== "off")) {
            return undefined;
          }
          const card = await adminCommands.notifyPunishToggleCard(
            scope,
            value === "on",
            userId,
            event.groupId,
          );
          return card.rich;
        }
        if (parsed.action === "punishTest") {
          const card = await adminCommands.notifyPunishTestCard(
            event.groupId,
            userId,
            event.groupId,
          );
          return card.rich;
        }
        if (parsed.action === "punishView") {
          return adminCommands.notifyPunishCard(event.groupId, userId).rich;
        }
        return adminCommands.notifyCard(event.groupId, userId).rich;
      },
    ],
    [
      "blacklist",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        if (parsed.action === "del") {
          const [scope, targetGroupId, targetUserId, page] = parsed.args;
          if (!scope || !targetUserId) {
            return undefined;
          }
          const card = await adminCommands.blacklistDeleteCard(
            scope,
            targetGroupId ?? "",
            targetUserId,
            Number.parseInt(page ?? "1", 10) || 1,
            userId,
            event.groupId,
          );
          return card.rich;
        }
        const [scope, targetGroupId, page] = parsed.args;
        return adminCommands.blacklistScopeCard(
          scope ?? "group",
          targetGroupId ?? event.groupId ?? "",
          Number.parseInt(page ?? "1", 10) || 1,
          userId,
        ).rich;
      },
    ],
    [
      "punish",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        const card = await adminCommands.punishCallbackCard(
          parsed.action,
          parsed.args,
          userId,
          event.groupId,
        );
        return card?.rich;
      },
    ],
    [
      "appeal",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        const card = await adminCommands.appealCallbackCard(
          parsed.action,
          parsed.args,
          userId,
          event.groupId,
        );
        return card?.rich;
      },
    ],
    [
      "activity",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        // 活动回调：join / quit / info / signups / page / config / preview / open /
        // cancel / release / resend / status / set / bind / unbind / college / year /
        // subscribe / stats / export 全部由 AdminCommandService 内部再做一次权限校验。
        //
        // §B4：群内报名 / 取消报名是**静默**的（结果只私信），此时返回 undefined 表示
        // 「这个回调不产生群消息」；renderer 返回 undefined 时 CallbackRouter 只回包。
        const card = await adminCommands.activityCallbackCard(
          parsed.action,
          parsed.args,
          userId,
          event.groupId,
        );
        return card?.rich;
      },
    ],
    [
      // 通用「运行固定指令」回调：cb:cmd:run:/myperm —— 走与手输完全一样的权限与审计
      "cmd",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        const command = parsed.args.join(":").trim();
        if (!command.startsWith("/")) {
          return undefined;
        }
        const result = await adminCommands.handle(event.groupId, userId, command);
        return result.rich;
      },
    ],
    ["testmenu", (parsed, event) => testMenu.render(parsed, event)],
  ]);
  const interactionHandler = new CallbackRouter({
    api,
    sender: richMessages,
    renderers: callbackRenderers,
  });
  const load = async (): Promise<void> => {
    await identityMap.reload();
    await auditLog.load();
    await joinAudit.load();
    await configStore.load();
    await permissions.load();
    await groupMessageMode.load();
    await activity.load();
    await activityNotifications.load();
    await notifications.load();
    await blacklist.load();
    await punishments.load();
    await appeals.load();
    await shortCodes.load();
    await userProfiles.load();
    await classAliases.load();
    await menuState.load();
    // 班级库缺失时不抛错：班级类规则会自动退化为人工审核
    const roster = await MemberRoster.load(settings.classIndexFile);
    joinRules.setRoster(roster);
    userProfiles.setRoster(roster);
    classAliases.setRoster(roster);
    joinRules.setAliases(classAliases);
    // 活动卡片的「学院限制 / 年级限制」按钮需要班级库（缺省时对应按钮不生成）
    adminCommands.setActivityRoster(roster);
    await writeQueue.flush();
  };
  return {
    mode: settings.qqBotAppId && settings.qqBotClientSecret ? "official" : "fake",
    api,
    auditLog,
    joinAudit,
    configStore,
    groupMessageMode,
    identityMap,
    permissions,
    activity,
    activityCards,
    activityNotifications,
    userProfiles,
    classAliases,
    exportService,
    notifications,
    blacklist,
    punishments,
    appeals,
    moderationNotifier,
    shortCodes,
    display,
    writeQueue,
    adminCommands,
    richMessages,
    menuState,
    testMenu,
    router: new EventRouter(
      messageGuard,
      joinAudit,
      adminCommands,
      joinApproval,
      notifications,
      interactionHandler,
    ),
    load,
    flush: async () => {
      await writeQueue.flush();
      await activityNotifications.flush();
    },
  };
}

function createFirstMenuPushState(
  settings: Settings,
  repository: MenuDeliveryRepository | undefined,
  queue: WriteQueue,
): FirstMenuPushState {
  if (settings.menuFirstPush === "persistent" && repository) {
    return new PersistentFirstMenuPushState(repository, queue);
  }
  if (settings.menuFirstPush === "persistent" && !repository) {
    getLogger("runtime").warn(
      "MENU_FIRST_PUSH=persistent 但当前是纯内存数据库模式，降级为内存记录",
    );
  }
  return new MemoryFirstMenuPushState();
}

function createApi(settings: Settings): QQOfficialAPI {
  if (settings.qqBotAppId && settings.qqBotClientSecret) {
    const cacheStore = createBotCacheStore(settings);
    return new QQOfficialClient(settings.qqBotAppId, settings.qqBotClientSecret, {
      token: settings.qqBotToken,
      transport: instrumentTransport(new FetchTransport(), getLogger("runtime")),
      ...(cacheStore ? { cacheStore } : {}),
    });
  }
  return new FakeQQOfficialAPI();
}

function createBotCacheStore(settings: Settings): BotCacheStore | undefined {
  const file = settings.qqBotCacheFile.trim();
  return file.length > 0 ? new FileBotCacheStore(file) : undefined;
}
