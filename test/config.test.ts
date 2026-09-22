import { describe, expect, it } from "vitest";

import { hasQqCredentials, loadSettings } from "../src/config.js";

describe("loadSettings", () => {
  it("loads defaults", () => {
    const settings = loadSettings({});
    expect(hasQqCredentials(settings)).toBe(false);
    expect(settings.rawMessageRetentionDays).toBe(0);
    expect(settings.auditLogRetentionDays).toBe(180);
  });

  it("loads environment values", () => {
    const settings = loadSettings({
      QQ_BOT_APP_ID: "123",
      QQ_BOT_CLIENT_SECRET: "secret",
      QQ_BOT_SANDBOX: "true",
      ADMIN_QQ_IDS: "1, 2",
      RAW_MESSAGE_RETENTION_DAYS: "7",
    });
    expect(hasQqCredentials(settings)).toBe(true);
    expect(settings.qqBotSandbox).toBe(true);
    expect(settings.adminQqIds).toEqual(["1", "2"]);
    expect(settings.rawMessageRetentionDays).toBe(7);
  });
});
