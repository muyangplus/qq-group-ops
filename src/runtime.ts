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
import type { AuditRepository } from "./db/auditRepository.js";
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
import { WriteQueue } from "./db/writeQueue.js";
import { ActivityService } from "./services/activity.js";
import { ActivityCardService } from "./services/activityCards.js";
import { AdminCommandService } from "./services/adminCommands.js";
import { AuditLogStore } from "./services/audit.js";
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
import { RuleEngine } from "./services/moderation.js";
import { NotificationService } from "./services/notifications.js";
import { PermissionService } from "./services/permissions.js";
import { RichMessageSender } from "./services/richMessages.js";
import { ShortCodeService } from "./services/shortCodes.js";
import { TestMenuService } from "./services/testMenu.js";
import { UserProfileService } from "./services/userProfiles.js";

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
  userProfiles: UserProfileService;
  exportService: ExportService;
  notifications: NotificationService;
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
  notificationSubscriptions?: NotificationSubscriptionRepository;
  notificationDeliveries?: NotificationDeliveryRepository;
  shortCodes?: ShortCodeRepository;
  userProfiles?: UserProfileRepository;
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
  );
  const activityCards = new ActivityCardService(richMessages, display);
  const testMenu = new TestMenuService({
    api,
    sender: richMessages,
    permissions,
  });
  const userProfiles = new UserProfileService(repositories.userProfiles, writeQueue);
  const exportService = new ExportService(permissions, auditLog);
  const joinRules = new JoinRuleEvaluator();
  const messageGuard = new MessageGuardService(
    api,
    new RuleEngine(),
    configStore,
    auditLog,
    permissions,
  );
  const joinApproval = new JoinApprovalService(
    api,
    joinAudit,
    configStore,
    joinRules,
  );
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
    activity,
    activityCards,
    notifications,
  });
  const menuState = createFirstMenuPushState(settings, repositories.menuDeliveries, writeQueue);
  const load = async (): Promise<void> => {
    await identityMap.reload();
    await auditLog.load();
    await joinAudit.load();
    await configStore.load();
    await permissions.load();
    await groupMessageMode.load();
    await activity.load();
    await notifications.load();
    await shortCodes.load();
    await userProfiles.load();
    await menuState.load();
    // 班级库缺失时不抛错：班级类规则会自动退化为人工审核
    const roster = await MemberRoster.load(settings.classIndexFile);
    joinRules.setRoster(roster);
    userProfiles.setRoster(roster);
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
    userProfiles,
    exportService,
    notifications,
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
      testMenu,
    ),
    load,
    flush: () => writeQueue.flush(),
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
