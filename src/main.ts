import { hasQqCredentials, loadSettings } from "./config.js";

function main(): void {
  const settings = loadSettings();
  console.log("qq-group-ops Node.js skeleton");
  console.log(`QQ credentials configured: ${hasQqCredentials(settings)}`);
  console.log(`database url configured: ${Boolean(settings.databaseUrl)}`);
  console.log(`raw message retention days: ${settings.rawMessageRetentionDays}`);
  console.log(`audit log retention days: ${settings.auditLogRetentionDays}`);
  console.log("TODO Phase 1: start official bot gateway and admin API.");
}

main();
