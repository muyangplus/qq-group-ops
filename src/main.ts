import { NativeWebSocketFactory } from "./adapters/nativeWebSocketFactory.js";
import { QQOfficialEventMapper } from "./adapters/qqOfficialEventMapper.js";
import { QQOfficialGateway } from "./adapters/qqOfficialGateway.js";
import { hasQqCredentials, loadSettings } from "./config.js";
import { instrumentEventGateway } from "./core/instrumentation.js";
import { closeLogging, configureLogging, getLogger } from "./core/logger.js";
import { loadEnvFile } from "./env.js";
import { attachGateway } from "./gatewayRunner.js";
import { connectPersistence } from "./persistence.js";
import { createRuntime } from "./runtime.js";

async function main(): Promise<void> {
  loadEnvFile();
  const settings = loadSettings();
  configureLogging({
    level: settings.logLevel,
    file: settings.logFile,
    console: settings.logConsole,
    color: settings.logColor,
  });
  const log = getLogger("main");

  const persistence = await connectPersistence(settings);
  const runtime = createRuntime(
    settings,
    persistence
      ? {
          repositories: {
            audit: persistence.audit,
            joinRequests: persistence.joinRequests,
            groupConfigs: persistence.groupConfigs,
            identityBindings: persistence.identityBindings,
            groupMessageModes: persistence.groupMessageModes,
            permissions: persistence.permissions,
            activities: persistence.activities,
          },
        }
      : {},
  );
  if (persistence) {
    await runtime.load();
  }

  log.info("qq-group-ops Node.js runtime");
  log.info("configuration loaded", {
    qqCredentialsConfigured: hasQqCredentials(settings),
    runtimeMode: runtime.mode,
    persistenceEnabled: Boolean(persistence),
    rawMessageRetentionDays: settings.rawMessageRetentionDays,
    auditLogRetentionDays: settings.auditLogRetentionDays,
    logLevel: settings.logLevel,
    logFile: settings.logFile,
  });

  if (runtime.mode === "fake") {
    log.warn("fake mode: official WebSocket gateway not started");
    await runtime.flush();
    await persistence?.close();
    await closeLogging();
    return;
  }

  const gateway = instrumentEventGateway(
    new QQOfficialGateway({
      api: runtime.api,
      createSocket: (url) => new NativeWebSocketFactory(url).create(),
      mapper: new QQOfficialEventMapper(),
      onHello: (heartbeatIntervalMs) => {
        log.debug("gateway hello", { heartbeatIntervalMs });
      },
      onReady: () => {
        log.info("gateway ready: bot authenticated");
      },
      onError: (error) => {
        log.error("gateway error", { error: formatError(error) });
      },
      onGroupMessageMode: (groupId, enabled) => {
        runtime.groupMessageMode.setEnabled(groupId, enabled);
        void runtime.flush();
        log.info("group full-message mode changed", { groupId, enabled });
      },
    }),
    log,
  );

  await attachGateway(runtime, gateway);
  log.info("official WebSocket gateway started");

  const shutdown = async (): Promise<void> => {
    await gateway.stop();
    await runtime.flush();
    await persistence?.close();
    await closeLogging();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
