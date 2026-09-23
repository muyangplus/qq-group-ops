import { FetchTransport } from "./adapters/fetchTransport.js";
import { FakeQQOfficialAPI } from "./adapters/fakeQqOfficial.js";
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
import type { IdentityBindingRepository } from "./db/identityBindingRepository.js";
import { AdminCommandService } from "./services/adminCommands.js";
import { InMemoryAuditLog } from "./services/audit.js";
import { EventRouter } from "./services/eventRouter.js";
import { GroupConfigStore } from "./services/groupConfig.js";
import { GroupMessageModeRegistry } from "./services/groupMessageMode.js";
import { IdentityMapService } from "./services/identityMap.js";
import { JoinAuditService } from "./services/joinAudit.js";
import { MessageGuardService } from "./services/messageGuard.js";
import { RuleEngine } from "./services/moderation.js";
import { PermissionService } from "./services/permissions.js";

export interface Runtime {
  mode: "official" | "fake";
  api: QQOfficialAPI;
  auditLog: InMemoryAuditLog;
  joinAudit: JoinAuditService;
  configStore: GroupConfigStore;
  groupMessageMode: GroupMessageModeRegistry;
  identityMap: IdentityMapService;
  router: EventRouter;
}

export interface RuntimeDependencies {
  /** 注入后，OpenID ↔ QQ号 / 群号 绑定会写穿透到数据库。 */
  identityBindings?: IdentityBindingRepository;
}

export function createRuntime(
  settings: Settings = loadSettings(),
  dependencies: RuntimeDependencies = {},
): Runtime {
  const api = instrumentQQOfficialAPI(createApi(settings), getLogger("runtime"));
  const auditLog = new InMemoryAuditLog();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: "__default__" });
  const groupMessageMode = new GroupMessageModeRegistry();
  const identityMap = new IdentityMapService(dependencies.identityBindings);
  const permissions = new PermissionService({
    superAdminIds: new Set(settings.adminUserIds),
  });
  const messageGuard = new MessageGuardService(
    api,
    new RuleEngine(),
    configStore,
    auditLog,
  );
  const adminCommands = new AdminCommandService(
    permissions,
    joinAudit,
    configStore,
    groupMessageMode,
    identityMap,
  );
  return {
    mode: settings.qqBotAppId && settings.qqBotClientSecret ? "official" : "fake",
    api,
    auditLog,
    joinAudit,
    configStore,
    groupMessageMode,
    identityMap,
    router: new EventRouter(messageGuard, joinAudit, adminCommands),
  };
}

function createApi(settings: Settings): QQOfficialAPI {
  if (settings.qqBotAppId && settings.qqBotClientSecret) {
    return new QQOfficialClient(settings.qqBotAppId, settings.qqBotClientSecret, {
      token: settings.qqBotToken,
      transport: instrumentTransport(new FetchTransport(), getLogger("runtime")),
    });
  }
  return new FakeQQOfficialAPI();
}
