import { NativeWebSocketFactory } from "./adapters/nativeWebSocketFactory.js";
import { QQOfficialEventMapper } from "./adapters/qqOfficialEventMapper.js";
import { QQOfficialGateway } from "./adapters/qqOfficialGateway.js";
import { hasQqCredentials, loadSettings } from "./config.js";
import { loadEnvFile } from "./env.js";
import { attachGateway } from "./gatewayRunner.js";
import { createRuntime } from "./runtime.js";

async function main(): Promise<void> {
  loadEnvFile();
  const settings = loadSettings();
  const runtime = createRuntime(settings);

  console.log("qq-group-ops Node.js runtime");
  console.log(`QQ credentials configured: ${hasQqCredentials(settings)}`);
  console.log(`runtime mode: ${runtime.mode}`);
  console.log(`raw message retention days: ${settings.rawMessageRetentionDays}`);
  console.log(`audit log retention days: ${settings.auditLogRetentionDays}`);

  if (runtime.mode === "fake") {
    console.log("fake mode: official WebSocket gateway not started.");
    return;
  }

  const gateway = new QQOfficialGateway({
    api: runtime.api,
    createSocket: (url) => new NativeWebSocketFactory(url).create(),
    mapper: new QQOfficialEventMapper(),
    onHello: (heartbeatIntervalMs) => {
      console.log(`gateway hello: heartbeat_interval=${heartbeatIntervalMs}ms`);
    },
    onReady: () => {
      console.log("gateway ready: bot authenticated");
    },
    onError: (error) => {
      console.error(`gateway error: ${String(error)}`);
    },
  });

  await attachGateway(runtime, gateway);
  console.log("official WebSocket gateway started.");

  const shutdown = async (): Promise<void> => {
    await gateway.stop();
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
