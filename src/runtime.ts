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
import { loadSettings, type MenuFirstPushMode, type Settings } from "./config.js";
import {
  instrumentQQOfficialAPI,
  instrumentTransport,
} from "./core/instrumentation.js";
import { getLogger } from "./core/logger.js";
import type { MigrationResult } from "./db/migrate.js";
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
import type { PrivacyRepository } from "./db/privacyRepository.js";
import type { AdminTokenRepository } from "./db/adminTokenRepository.js";
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
import { pageArg, pageTargets, type ParsedCallback } from "./services/callbackData.js";
import {
  CallbackRouter,
  type CallbackRenderer,
} from "./services/callbackRouter.js";
import { moduleForCallback } from "./services/commands/healthCommands.js";
import type { InteractionEvent } from "./services/eventRouter.js";
import { ActivityService } from "./services/activity.js";
import { ActivityCardService } from "./services/activityCards.js";
import { ActivityExportService } from "./services/activityExport.js";
import { ActivityStatsService } from "./services/activityStats.js";
import { ActivityNotificationService } from "./services/activityNotifications.js";
import { AdminCommandService } from "./services/adminCommands.js";
import { isNotifyChannel } from "./services/commands/notifyCommands.js";
import { setDisplayTimeZone } from "./core/timeFormat.js";
import { AppealService } from "./services/appeals.js";
import { AuditLogStore } from "./services/audit.js";
import { BlacklistService } from "./services/blacklist.js";
import { DisplayNameService } from "./services/displayNames.js";
import { EventRouter } from "./services/eventRouter.js";
import { ExportService } from "./services/export.js";
import {
  HotFirstMenuPushState,
  type FirstMenuPushState,
} from "./services/firstMenuPush.js";
import { PlatformSettingsStore } from "./services/platformSettings.js";
import type { HotSettingKey } from "./services/platformSettings.js";
import type { PlatformSettingsRepository } from "./db/platformSettingsRepository.js";
import type { RepositorySet } from "./persistence.js";
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
import { NotifyTopicLevelStore } from "./services/notifyTopics.js";
import { createRestartHook, type RestartHook, type RestartRequestHandler } from "./services/restart.js";
import type { DeployControl } from "./services/deployWatcher.js";
import { PermissionService } from "./services/permissions.js";
import { PunishmentService } from "./services/punishments.js";
import { RichMessageSender } from "./services/richMessages.js";
import { DataMigrationService } from "./services/dataMigration.js";
import { PrivacyService } from "./services/privacy.js";
import { AdminApiLinkService } from "./adminApi/loginLink.js";
import { loadAdminApiConfig, type AdminApiConfig } from "./adminApi/config.js";
import { createAdminApiBackend } from "./adminApi/backend.js";
import { createAdminApiEntities } from "./adminApi/entityRef.js";
import { backupDatabase } from "./services/dbBackup.js";
import { HealthRegistry } from "./services/health.js";
import {
  reserveGlobalCode,
  SHORT_CODE_LENGTH,
  ShortCodeService,
} from "./services/shortCodes.js";
import { TestMenuService } from "./services/testMenu.js";
import type { TickSchedulerState } from "./services/tickScheduler.js";
import { UserProfileService } from "./services/userProfiles.js";
import { ClassAliasService } from "./services/classAliases.js";

export interface Runtime {
  mode: "official" | "fake";
  api: QQOfficialAPI;
  /** 模块健康与功能闸门（层 1 隔离加载 / 层 2 拒绝执行）。 */
  health: HealthRegistry;
  /** 平台热配置（`/config`）：`.env` 默认 + 数据库覆盖，读时取值。 */
  platform: PlatformSettingsStore;
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
  /** 通知话题门槛（全局一套，存 `group_settings.__default__`）。 */
  notifyTopics: NotifyTopicLevelStore;
  /** `/restart` 的重启钩子（未装配时该指令拒绝执行）。 */
  restart: RestartHook;
  /** 部署监测（新版本自动重启）的控制面；未装配时没有待重启状态。 */
  deploy: DeployControl | undefined;
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
  /** 个人数据匿名化 / 导出（`/data`，D7）：暴露出来便于诊断「是否装了仓储」（`configured`）。 */
  privacy: PrivacyService;
  /** 私信首次交互主菜单的去重状态（dev 内存 / 正式入库）。 */
  menuState: FirstMenuPushState;
  /** 回调按钮翻页试验（`/testmenu`）。 */
  testMenu: TestMenuService;
  /**
   * 管理 API 的**同进程回环监听口**数据源（E1-d）。
   *
   * `ADMIN_API_ENABLED` 未开启时为 `undefined`；有值时由 `main.ts` 起第二个
   * Fastify 监听口，读写都落在本进程这同一份服务图上（见 docs/ADMIN-API.md §2）。
   */
  adminApiHost: AdminApiHostSource | undefined;
  /** 从数据库载入全部持久化状态；未配置数据库时为空操作。 */
  load(): Promise<void>;
  /** 等待所有排队写入落库。 */
  flush(): Promise<void>;
}

/** 起同进程管理 API 监听口所需的全部依赖。 */
export interface AdminApiHostSource {
  config: AdminApiConfig;
  /** 一次性登录令牌仓储；纯内存模式（无数据库）时为 `undefined`，没有它无法兑换令牌。 */
  tokens: AdminTokenRepository | undefined;
  /** 数据库类型（诊断用）：`memory` 时「没有令牌表」就出在这里。 */
  databaseDriver: string;
  /** 读 + 写后端：直接调本进程的领域服务，写端点自带权限校验与审计。 */
  backend: ReturnType<typeof createAdminApiBackend>;
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
  /** 平台级热配置（`/config`）。 */
  platformSettings?: PlatformSettingsRepository;
  /** 个人数据匿名化 / 导出（`/data`，D7）。 */
  privacy?: PrivacyRepository;
  /** 管理 API 的一次性登录令牌（E1）。 */
  adminTokens?: AdminTokenRepository;
}

export interface RuntimeDependencies {
  repositories?: RuntimeRepositories;
  /**
   * `/restart` 的落点：由 `main.ts` 注入「写重启回执 + 优雅关闭 + 进程退出」。
   * 缺省（纯单测 / 没有进程管理器）时 `runtime.restart.available === false`，
   * `/restart` 会明确拒绝而不是把进程杀掉。
   */
  onRestartRequested?: RestartRequestHandler | undefined;
  /** 部署监测（新版本自动重启）的控制面；由 `main.ts` 构造后注入。 */
  deploy?: DeployControl | undefined;
  /**
   * 周期任务状态的取值函数（管理 API 的 `/api/tasks`）。
   *
   * 为什么是函数：调度器在 `main.ts` 里**晚于本运行时创建**（先起监听口、再建调度器），
   * 所以只能等请求进来时再取。
   */
  tickTasks?: (() => TickSchedulerState | undefined) | undefined;
  /** 启动期迁移的非致命问题（`main.ts` 从 persistence 透传，供 `/status proc` 展示）。 */
  migration?: MigrationResult | undefined;
  /** 数据库类型（`sqlite` / `postgres` / `memory`）：管理 API 的 `/api/status` 展示用。 */
  databaseDriver?: string | undefined;
}

/**
 * 把整份 `Persistence`（或 `createRepositories()` 的产物）当仓储集合传给 `createRuntime`。
 *
 * 为什么要这个适配器：以前 `main.ts` 与测试替身是**逐个列举**仓储键的，结果各漏了几个
 * （生产路径漏 `privacy` 与 `adminTokens` → `/data` 与 `/admin login` 在真机上直接报「未装配」；
 * 测试替身还漏了 `platformSettings` / `blacklist` / `punishments` / `appeals` / `menuDeliveries`）。
 * 现在只在 `src/persistence.ts` 的 `createRepositories()` 里装配一次，这里做一次**编译期**转换：
 * `RepositorySet` 必须覆盖 `RuntimeRepositories` 要求的每一个键，否则 `pnpm typecheck` 直接报错。
 */
export function toRuntimeRepositories(
  repositories: RepositorySet,
): RuntimeRepositories {
  return repositories;
}

const log = getLogger("runtime");

export function createRuntime(
  settings: Settings = loadSettings(),
  dependencies: RuntimeDependencies = {},
): Runtime {
  const repositories = dependencies.repositories ?? {};
  // 展示时区（卡片时间 + 日志时间）：默认 UTC+8，`TZ` / `TIMEZONE` 可覆盖
  if (!setDisplayTimeZone(settings.displayTimezone)) {
    getLogger("runtime").warn(
      "invalid display timezone, falling back to UTC+8",
      { displayTimezone: settings.displayTimezone },
    );
  }
  const writeQueue = new WriteQueue();
  // 平台热配置（`/config`）：`.env` 是默认值，数据库覆盖优先；服务在用的时候读它
  const platform = new PlatformSettingsStore(
    settings,
    repositories.platformSettings,
    writeQueue,
  );
  const api = instrumentQQOfficialAPI(createApi(settings), getLogger("runtime"));
  /** 运行模式：有机器人凭据就是 official，否则 fake（管理 API 的运维页也要显示它）。 */
  const mode: Runtime["mode"] =
    settings.qqBotAppId && settings.qqBotClientSecret ? "official" : "fake";
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
  const notifyTopics = new NotifyTopicLevelStore(
    repositories.groupSettings,
    writeQueue,
  );
  const restart = createRestartHook(dependencies.onRestartRequested);
  const notifications = new NotificationService(api, permissions, {
    subscriptions: repositories.notificationSubscriptions,
    deliveries: repositories.notificationDeliveries,
    queue: writeQueue,
    identityMap,
    display,
    configStore,
    joinRules,
    notifyTopics,
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
  // §B8 申诉派发口径：管理员全部通知，审核员轮单（超时由 AppealWatcher 转下一位）。
  const moderationNotifier = new ModerationNotifier({
    notifications,
    permissions,
    groupLabel: (groupId) => display.group(groupId),
    userLabel: (userId) => display.user(userId),
    // 申诉人那张结果卡只给处理人的**短码**（不给 QQ 号/昵称）
    userShortLabel: (userId) => shortCodes.label("user", userId),
    // 热配置（/config）：申诉超时轮转按「用的时候」的当前值判断
    appealHoldMs: () => platform.get("appealHoldMinutes") * 60_000,
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
    blacklist,
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
    repositories.activityNotifications,
    // 满员广播是**群消息**：直接复用富消息发送器发到绑定群（不占用户私信额度）。
    {
      dailyLimit: () => platform.get("activityNotifyDailyLimit"),
      ratePerSecond: () => platform.get("activityNotifyRatePerSecond"),
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
    fontUrl: () => platform.get("activityStatsFontUrl"),
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
  // 一次性数据迁移（`/migrate`）：只做存储层改写，改完把内存态整个重载
  // 迁移执行前自动备份数据库（SQLite 文件副本）
  const reloadPersistedState = async (): Promise<void> => {
    await Promise.all([
      configStore.load(),
      userProfiles.load(),
      shortCodes.load(),
      activity.load(),
    ]);
  };
  const dataMigration = new DataMigrationService({
    settings: repositories.groupSettings,
    profiles: repositories.userProfiles,
    activityDetails: repositories.activityDetails,
    shortCodes: repositories.shortCodes,
    generateCode: () => reserveGlobalCode(SHORT_CODE_LENGTH),
    backup: () => backupDatabase(settings.databaseTarget),
    reload: reloadPersistedState,
  });
  // 个人数据匿名化 / 导出（D7）：同样只做存储层改写，但要把**认人**的那几份内存态一起重载
  // （绑定、订阅、活动通知去重），否则本地还认得出被匿名化的人
  const privacy = new PrivacyService({
    repository: repositories.privacy,
    reload: async () => {
      await Promise.all([
        reloadPersistedState(),
        identityMap.reload(),
        notifications.load(),
        activityNotifications.load(),
      ]);
    },
    sender: richMessages,
  });
  // 管理后台登录令牌（E1-b）：配置没开或没有令牌仓储时 `enabled` 为 false，指令会明确说明
  const adminApiConfig = loadAdminApiConfig();
  const adminApiLink = new AdminApiLinkService({
    tokens: repositories.adminTokens,
    config: adminApiConfig,
    permissions,
  });
  /**
   * 管理 API 的读 + 写后端（E1-d）：接的是**本进程**的服务图，不是另一套仓储连接。
   * 写端点因此与指令层走同一入口（审批走 `JoinApprovalService`、规则走
   * `GroupConfigStore.setOverride`、活动状态走 `ActivityService`），不存在两份内存态。
   * 配置没开时不构造（纯单测 / 未启用时零开销）。
   */
  const adminApiBackend = adminApiConfig.enabled
    ? createAdminApiBackend({
        permissions,
        auditLog,
        joinAudit,
        joinApproval,
        configStore,
        activity,
        activityExport,
        // P2 写：改活动字段复用指令层 `/activity set` 的解析与连带效果（满员广播 / 变更私信）。
        // `adminCommands` 在本函数后面才创建，所以这里用惰性闭包（端点被调用时它早就绪）。
        updateActivitySetting: (activityId, field, value) =>
          adminCommands.updateActivitySetting(activityId, field, value),
        adminTokens: repositories.adminTokens,
        notificationSubscriptions: repositories.notificationSubscriptions,
        groupSettings: repositories.groupSettings,
        shortCodes,
        // 展示层（E2-e）：列表/选择器优先出群号与 QQ 号，其次短码，完整长码留给详情行。
        // 短码**只查不造** —— 列一页审计不该顺手给历史 actor 发码。
        entities: createAdminApiEntities({
          qqOf: (userId) => identityMap.getQq(userId),
          groupNumberOf: (groupId) => identityMap.getGroupNumber(groupId),
          shortCodeOf: (kind, targetId) =>
            shortCodes.existingCode(kind, targetId),
        }),
        tickTasks: dependencies.tickTasks,
        deploy: dependencies.deploy,
        // 配置页（E2-f）：读写都走机器人 `/config` 用的那一套热改存储，不另造通路
        platform,
        // P1 只读补齐：处罚 / 黑名单 / 申诉 / 投递 / 运维状态（全部走各自领域服务）
        punishments,
        blacklist,
        appeals,
        userProfiles,
        notificationDeliveries: repositories.notificationDeliveries,
        notifications,
        // 健康表创建在管理后端之后（它引用几乎所有服务），只能惰性取
        health: () => health,
        writeQueue,
        migration: dependencies.migration,
        mode,
        joinSync,
        exportService,
        // P2 写：申诉结论要私信申诉人（与指令层同一个 ModerationNotifier）
        moderationNotifier,
        // P2 写：话题门槛的读写都走 `/notify level` 同一份存储
        notifyTopics,
        // P2 写：别名表与 `/alias` 同一份数据
        classAliases,
        database: dependencies.databaseDriver,
        migrationIssues: dependencies.migration?.issues.length,
      })
    : undefined;
  // 模块健康：单个模块加载失败只降级它自己（层 1），它的功能域由闸门拦住（层 2）
  const menuState = createFirstMenuPushState(
    () => platform.get("menuFirstPush"),
    repositories.menuDeliveries,
    writeQueue,
  );
  const health = new HealthRegistry([
    { key: "platform", load: () => platform.load() },
    { key: "identity", load: () => identityMap.reload() },
    { key: "audit", load: () => auditLog.load() },
    { key: "join", load: () => joinAudit.load() },
    { key: "config", load: () => configStore.load() },
    {
      key: "notify",
      load: async () => {
        await notifyTopics.load();
        await notifications.load();
      },
    },
    { key: "permissions", load: () => permissions.load() },
    { key: "groupmessage", load: () => groupMessageMode.load() },
    {
      key: "activity",
      load: async () => {
        await activity.load();
        await activityNotifications.load();
      },
    },
    {
      key: "sanction",
      load: async () => {
        await punishments.load();
        await appeals.load();
      },
    },
    { key: "blacklist", load: () => blacklist.load() },
    { key: "shortcode", load: () => shortCodes.load() },
    { key: "profile", load: () => userProfiles.load() },
    { key: "alias", load: () => classAliases.load() },
    { key: "menu", load: () => menuState.load() },
  ]);
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
    exportService,
    blacklist,
    punishments,
    appeals,
    moderationNotifier,
    richMessages,
    cardSender: richMessages,
    diagnostics: { settings, writeQueue, migration: dependencies.migration },
    restart,
    deploy: dependencies.deploy,
    migrate: dataMigration,
    privacy,
    adminApi: adminApiLink,
    health,
    platform,
  });
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
      "deploy",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        if (parsed.action === "cancel") {
          return adminCommands.deployCancelCard(userId).rich;
        }
        if (parsed.action === "now") {
          return adminCommands.deployRestartNowCard(userId, event.groupId).rich;
        }
        return undefined;
      },
    ],
    [
      "restart",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        if (parsed.action === "go") {
          return adminCommands.restartNowCard(userId, event.groupId).rich;
        }
        // 自检失败卡上的两个出口：跳过自检 / 只再检查一次
        if (parsed.action === "force") {
          return adminCommands.restartNowCard(userId, event.groupId, true).rich;
        }
        if (parsed.action === "again") {
          return adminCommands.restartCheckCard(userId).rich;
        }
        // 失败卡上的「自检结果」：把 data/startup-check.json 原文发过来
        if (parsed.action === "detail") {
          return adminCommands.startupCheckCard(userId).rich;
        }
        return undefined;
      },
    ],
    [
      "migrate",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        if (parsed.action === "run") {
          const card = await adminCommands.migrateRunCard(userId, event.groupId);
          return card.rich;
        }
        if (parsed.action === "preview") {
          const card = await adminCommands.migrateRefreshCard(
            userId,
            event.groupId,
          );
          return card.rich;
        }
        return undefined;
      },
    ],
    [
      "status",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        // `cb:status:proc` → 进程全套详情（仅全局超管）；`cb:status:view:<群>` → 群状态卡
        if (parsed.action === "proc") {
          return adminCommands.processCard(userId).rich;
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
        if (parsed.action === "punishToggle") {
          const [targetGroupId, key] = parsed.args;
          if (!targetGroupId || !key) {
            return undefined;
          }
          return adminCommands.punishToggleCard(
            targetGroupId,
            key,
            userId,
            event.groupId,
          ).rich;
        }
        if (parsed.action === "keywords") {
          // 词表走私信：群内明文列出违规词会被平台判「消息内容违规」
          const [targetGroupId, page] = parsed.args;
          if (!targetGroupId) {
            return undefined;
          }
          const card = await adminCommands.keywordListCard(
            targetGroupId,
            userId,
            Number.parseInt(page ?? "1", 10) || 1,
            event.groupId,
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
        // 统一订阅菜单：`cb:notify:set:<频道>:<范围>:<on|off>` / `test:<频道>` / `view`
        if (parsed.action === "set") {
          const [channel, scope, value] = parsed.args;
          if (!channel || !scope || (value !== "on" && value !== "off")) {
            return undefined;
          }
          const card = await adminCommands.notifyToggleCard(
            channel,
            scope,
            value === "on",
            userId,
            event.groupId,
          );
          return card.rich;
        }
        if (parsed.action === "test") {
          const channel = parsed.args[0];
          if (!channel || !isNotifyChannel(channel)) {
            return undefined;
          }
          const card = await adminCommands.notifyTestCard(
            channel,
            userId,
            event.groupId,
            event.groupId,
          );
          return card.rich;
        }
        // 推送卡底部的「取消订阅此通知」：`cb:notify:unsub:<话题>:<范围>`
        if (parsed.action === "unsub") {
          const [topic, scope] = parsed.args;
          if (!topic || !scope) {
            return undefined;
          }
          return adminCommands.notifyUnsubscribeCard(
            topic,
            scope,
            userId,
            event.groupId,
          ).rich;
        }
        // 话题门槛子卡（仅全局超管）：查看 / 翻页 / 恢复默认
        if (parsed.action === "level") {
          return adminCommands.notifyLevelPanel(
            userId,
            undefined,
            pageArg(parsed.args) ?? 1,
          ).rich;
        }
        if (parsed.action === "levelReset") {
          return adminCommands.notifyResetLevelsCard(userId, event.groupId).rich;
        }
        // 其余动作（`view` / 未知）都回到通知中心；`view` 可带页码
        const page = parsed.action === "view" ? pageArg(parsed.args) : undefined;
        return adminCommands.notifyCard(event.groupId, userId, undefined, page)
          .rich;
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
    [
      "config",
      async (parsed, event) => {
        const userId = event.userId;
        if (!userId) {
          return undefined;
        }
        return adminCommands.configPanelCard(userId, pageArg(parsed.args) ?? 1)
          .rich;
      },
    ],
    [
      "health",
      async (parsed, event) => {
        const userId = event.userId;
        const key = parsed.args[0];
        if (!userId || parsed.action !== "retry" || !key) {
          return undefined;
        }
        const card = await adminCommands.moduleRetryCard(userId, key);
        return card.rich;
      },
    ],
  ]);
  // 层 2 闸门（回调）：模块降级时对应命名空间的按钮一律拒绝执行
  const guardedRenderers = new Map<string, CallbackRenderer>(
    [...callbackRenderers].map(([namespace, renderer]) => [
      namespace,
      async (parsed: ParsedCallback, event: InteractionEvent) => {
        const module = moduleForCallback(namespace);
        const userId = event.userId;
        if (module === undefined || !userId || health.isAvailable(module)) {
          return renderer(parsed, event);
        }
        log.warn("callback blocked: module unavailable", { namespace, module });
        return adminCommands.moduleUnavailableMessage(userId, module);
      },
    ]),
  );
  const interactionHandler = new CallbackRouter({
    api,
    sender: richMessages,
    renderers: guardedRenderers,
  });
  /**
   * 需要在系统里「主动推一下」才生效的热配置项（其余项都是读时取值，改完自然生效）：
   * 待审批申请的有效期（服务里存的是毫秒数）、展示时区（模块级设置）。
   */
  const applyHotSetting = (key: HotSettingKey): void => {
    if (key === "joinRequestTtlDays") {
      joinAudit.setPendingTtlMs(
        platform.get("joinRequestTtlDays") * 24 * 60 * 60 * 1_000,
      );
    }
    if (key === "displayTimezone") {
      const timezone = platform.get("displayTimezone");
      if (!setDisplayTimeZone(timezone)) {
        log.warn("invalid display timezone, keeping previous", { timezone });
      }
    }
  };
  platform.onChange(applyHotSetting);

  const load = async (): Promise<void> => {
    // 层 1：逐个模块隔离加载，失败的只标记降级、不中断启动
    const report = await health.loadAll();
    if (report.degraded.length > 0) {
      log.warn("modules degraded at startup", {
        modules: report.degraded.map((status) => status.key),
      });
    }
    // 平台配置刚从库里读出来：把「需要主动生效」的两项按覆盖值推一遍
    applyHotSetting("joinRequestTtlDays");
    applyHotSetting("displayTimezone");
    // 超管专属话题「默认开」：给现有全局超管补订阅行（权限/通知模块没起来时跳过，不拦启动）
    if (health.isAllAvailable(["permissions", "notify"])) {
      notifications.seedSuperAdminDefaults(permissions.listSuperAdmins());
    }
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
    mode,
    api,
    health,
    platform,
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
    notifyTopics,
    restart,
    deploy: dependencies.deploy,
    blacklist,
    punishments,
    appeals,
    moderationNotifier,
    shortCodes,
    display,
    writeQueue,
    adminCommands,
    richMessages,
    privacy,
    menuState,
    testMenu,
    adminApiHost:
      adminApiConfig.enabled && adminApiBackend
        ? {
            config: adminApiConfig,
            tokens: repositories.adminTokens,
            databaseDriver: dependencies.databaseDriver ?? "memory",
            backend: adminApiBackend,
          }
        : undefined,
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
      await notifyTopics.flush();
      await activityNotifications.flush();
    },
  };
}

/**
 * 首次菜单推送的去重状态。
 *
 * 模式是**热配置**（`MENU_FIRST_PUSH` 可在 `/config` 改），所以返回的是
 * `HotFirstMenuPushState`：一份去重集合，当前模式只决定要不要落库；
 * `persistent` 但没有数据库时降级为内存记录（老行为）。
 */
function createFirstMenuPushState(
  mode: () => MenuFirstPushMode,
  repository: MenuDeliveryRepository | undefined,
  queue: WriteQueue,
): FirstMenuPushState {
  if (mode() === "persistent" && !repository) {
    getLogger("runtime").warn(
      "MENU_FIRST_PUSH=persistent 但当前是纯内存数据库模式，降级为内存记录",
    );
  }
  return new HotFirstMenuPushState(mode, repository, queue);
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
