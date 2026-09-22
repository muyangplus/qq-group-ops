import { describe, expect, it } from "vitest";

import { hasQqCredentials, loadSettings } from "../src/config.js";

describe("loadSettings", () => {
  it("loads defaults", () => {
    const settings = loadSettings({});
    expect(hasQqCredentials(settings)).toBe(false);
    expect(settings.rawMessageRetentionDays).toBe(0);
    expect(settings.auditLogRetentionDays).toBe(180);
    expect(settings.logFile).toBe("logs/qq-group-ops.log");
    expect(settings.logConsole).toBe(true);
    expect(settings.logColor).toBe("auto");
  });

  it("loads environment values", () => {
    const settings = loadSettings({
      QQ_BOT_APP_ID: "123",
      QQ_BOT_CLIENT_SECRET: "secret",
      QQ_BOT_SANDBOX: "true",
      ADMIN_USER_IDS: "1, 2",
      RAW_MESSAGE_RETENTION_DAYS: "7",
      LOG_FILE: "custom.log",
      LOG_CONSOLE: "false",
      LOG_COLOR: "never",
    });
    expect(hasQqCredentials(settings)).toBe(true);
    expect(settings.qqBotSandbox).toBe(true);
    expect(settings.adminUserIds).toEqual(["1", "2"]);
    expect(settings.rawMessageRetentionDays).toBe(7);
    expect(settings.logFile).toBe("custom.log");
    expect(settings.logConsole).toBe(false);
    expect(settings.logColor).toBe("never");
  });

  it("supports the legacy ADMIN_QQ_IDS alias", () => {
    const settings = loadSettings({ ADMIN_QQ_IDS: "legacy" });
    expect(settings.adminUserIds).toEqual(["legacy"]);
  });
});
