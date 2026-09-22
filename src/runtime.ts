import { FetchTransport } from "./adapters/fetchTransport.js";
import { FakeQQOfficialAPI } from "./adapters/fakeQqOfficial.js";
import {
  QQOfficialClient,
  type QQOfficialAPI,
} from "./adapters/qqOfficial.js";
import { loadSettings, type Settings } from "./config.js";
import { AdminCommandService } from "./services/adminCommands.js";
import { InMemoryAuditLog } from "./services/audit.js";
import { EventRouter } from "./services/eventRouter.js";
import { GroupConfigStore } from "./services/groupConfig.js";
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
  router: EventRouter;
}

export function createRuntime(settings: Settings = loadSettings()): Runtime {
  const api = createApi(settings);
  const auditLog = new InMemoryAuditLog();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: "__default__" });
  const permissions = new PermissionService({
    superAdminIds: new Set(settings.adminQqIds),
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
  );
  return {
    mode: settings.qqBotAppId && settings.qqBotClientSecret ? "official" : "fake",
    api,
    auditLog,
    joinAudit,
    configStore,
    router: new EventRouter(messageGuard, joinAudit, adminCommands),
  };
}

function createApi(settings: Settings): QQOfficialAPI {
  if (settings.qqBotAppId && settings.qqBotClientSecret) {
    return new QQOfficialClient(settings.qqBotAppId, settings.qqBotClientSecret, {
      token: settings.qqBotToken,
      transport: new FetchTransport(),
    });
  }
  return new FakeQQOfficialAPI();
}
