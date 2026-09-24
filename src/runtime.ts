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
import type { ClassAliasRepository } from "./db/classAliasRepository.js";
import { WriteQueue } from "./db/writeQueue.js";
import { pageArg, pageTargets } from "./services/callbackData.js";
import {
  CallbackRouter,
  type CallbackRenderer,
} from "./services/callbackRouter.js";
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
  userProfiles: UserProfileService;
  classAliases: ClassAliasService;
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
  );
  const activityCards = new ActivityCardService(richMessages, display);
  const testMenu = new TestMenuService({ permissions });
  const userProfiles = new UserProfileService(repositories.userProfiles, writeQueue);
  const classAliases = new ClassAliasService(
    repositories.classAliases,
    writeQueue,
  );
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
    classAliases,
    activity,
    activityCards,
    notifications,
  });
  const menuState = createFirstMenuPushState(settings, repositories.menuDeliveries, writeQueue);
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
        if (parsed.action === "toggle") {
          const [targetGroupId, field, value, panel] = parsed.args;
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
          );
          return card.rich;
        }
        if (parsed.action === "panel") {
          const [targetGroupId, panel] = parsed.args;
          if (!targetGroupId || !panel) {
            return undefined;
          }
          return adminCommands.rulesPanelCard(panel, targetGroupId, userId).rich;
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
        return adminCommands.notifyCard(event.groupId, userId).rich;
      },
    ],
    [
      "activity",
      async (parsed, event) => {
        const userId = event.userId;
        const group =
          parsed.args[0] && parsed.args[0].length > 0
            ? parsed.args[0]
            : event.groupId;
        if (!userId || !group) {
          return undefined;
        }
        return adminCommands.activityListCard(
          group,
          userId,
          Number.parseInt(parsed.args[1] ?? "1", 10) || 1,
        ).rich;
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
    await notifications.load();
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
    classAliases,
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
      interactionHandler,
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
