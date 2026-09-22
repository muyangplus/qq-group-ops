import { hasQqCredentials, loadSettings } from "./config.js";
import { createRuntime } from "./runtime.js";

function main(): void {
  const settings = loadSettings();
  const runtime = createRuntime(settings);
  console.log("qq-group-ops Node.js runtime");
  console.log(`QQ credentials configured: ${hasQqCredentials(settings)}`);
  console.log(`runtime mode: ${runtime.mode}`);
  console.log(`raw message retention days: ${settings.rawMessageRetentionDays}`);
  console.log(`audit log retention days: ${settings.auditLogRetentionDays}`);
  console.log("TODO Phase 1: start official WebSocket/Webhook gateway.");
}

main();
