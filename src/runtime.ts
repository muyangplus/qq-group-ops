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
import type { AuditRepository } from "./db/auditRepository.js";
import type { GroupConfigRepository } from "./db/groupConfigRepository.js";
import type { GroupMessageModeRepository } from "./db/groupMessageModeRepository.js";
import type { IdentityBindingRepository } from "./db/identityBindingRepository.js";
import type { JoinRequestRepository } from "./db/joinRequestRepository.js";
import type { PermissionRepository } from "./db/permissionRepository.js";
import { WriteQueue } from "./db/writeQueue.js";
import { ActivityService } from "./services/activity.js";
import { AdminCommandService } from "./services/adminCommands.js";
import { AuditLogStore } from "./services/audit.js";
import { EventRouter } from "./services/eventRouter.js";
import { ExportService } from "./services/export.js";
import { GroupConfigStore } from "./services/groupConfig.js";
import { GroupMessageModeRegistry } from "./services/groupMessageMode.js";
import { IdentityMapService } from "./services/identityMap.js";
import { JoinApprovalService } from "./services/joinApproval.js";
import { JoinAuditService } from "./services/joinAudit.js";
import { MessageGuardService } from "./services/messageGuard.js";
import { RuleEngine } from "./services/moderation.js";
import { PermissionService } from "./services/permissions.js";

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
  exportService: ExportService;
  writeQueue: WriteQueue;
  router: EventRouter;
  /** 从数据库载入全部持久化状态；未配置数据库时为空操作。 */
  load(): Promise<void>;
  /** 等待所有排队写入落库。 */
  flush(): Promise<void>;
}

export interface RuntimeRepositories {
  audit?: AuditRepository;
  joinRequests?: JoinRequestRepository;
  groupConfigs?: GroupConfigRepository;
  identityBindings?: IdentityBindingRepository;
  groupMessageModes?: GroupMessageModeRepository;
  permissions?: PermissionRepository;
  activities?: ActivityRepository;
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
  const auditLog = new AuditLogStore(repositories.audit, writeQueue);
  const joinAudit = new JoinAuditService(
    auditLog,
    repositories.joinRequests,
    writeQueue,
  );
  const configStore = new GroupConfigStore(
    { groupId: "__default__" },
    repositories.groupConfigs,
    writeQueue,
  );
  const groupMessageMode = new GroupMessageModeRegistry(
    repositories.groupMessageModes,
    writeQueue,
  );
  const identityMap = new IdentityMapService(repositories.identityBindings);
  const permissions = new PermissionService(
    { superAdminIds: new Set(settings.adminUserIds) },
    repositories.permissions,
    writeQueue,
  );
  const activity = new ActivityService(repositories.activities, writeQueue);
  const exportService = new ExportService(permissions, auditLog);
  const messageGuard = new MessageGuardService(
    api,
    new RuleEngine(),
    configStore,
    auditLog,
  );
  const joinApproval = new JoinApprovalService(api, joinAudit, configStore);
  const adminCommands = new AdminCommandService(
    permissions,
    joinAudit,
    configStore,
    joinApproval,
    groupMessageMode,
    identityMap,
  );
  const load = async (): Promise<void> => {
    await identityMap.reload();
    await auditLog.load();
    await joinAudit.load();
    await configStore.load();
    await permissions.load();
    await groupMessageMode.load();
    await activity.load();
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
    exportService,
    writeQueue,
    router: new EventRouter(messageGuard, joinAudit, adminCommands, joinApproval),
    load,
    flush: () => writeQueue.flush(),
  };
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
