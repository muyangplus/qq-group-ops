import { describe, expect, it } from "vitest";

import {
  DEFAULT_SQLITE_PATH,
  hasQqCredentials,
  loadSettings,
  resolveDatabaseTarget,
} from "../src/config.js";

describe("loadSettings", () => {
  it("loads defaults", () => {
    const settings = loadSettings({});
    expect(hasQqCredentials(settings)).toBe(false);
    expect(settings.databaseTarget).toEqual({
      driver: "sqlite",
      path: DEFAULT_SQLITE_PATH,
    });
    expect(settings.databaseUrl).toBe("");
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

describe("resolveDatabaseTarget", () => {
  it("defaults to a SQLite file", () => {
    expect(resolveDatabaseTarget(undefined)).toEqual({
      driver: "sqlite",
      path: DEFAULT_SQLITE_PATH,
    });
    expect(resolveDatabaseTarget("")).toEqual({
      driver: "sqlite",
      path: DEFAULT_SQLITE_PATH,
    });
    expect(resolveDatabaseTarget("   ", "custom/db.sqlite")).toEqual({
      driver: "sqlite",
      path: "custom/db.sqlite",
    });
  });

  it("recognizes PostgreSQL URLs", () => {
    expect(
      resolveDatabaseTarget("postgres://user:pass@db:5432/ops"),
    ).toEqual({ driver: "postgres", url: "postgres://user:pass@db:5432/ops" });
    expect(
      resolveDatabaseTarget("postgresql://user:pass@db:5432/ops"),
    ).toEqual({
      driver: "postgres",
      url: "postgresql://user:pass@db:5432/ops",
    });
  });

  it("recognizes SQLite paths with and without the scheme", () => {
    expect(resolveDatabaseTarget("sqlite:./data/bot.db")).toEqual({
      driver: "sqlite",
      path: "./data/bot.db",
    });
    expect(resolveDatabaseTarget("sqlite:/var/lib/bot.db")).toEqual({
      driver: "sqlite",
      path: "/var/lib/bot.db",
    });
    expect(resolveDatabaseTarget("./data/bot.db")).toEqual({
      driver: "sqlite",
      path: "./data/bot.db",
    });
  });

  it("supports explicit in-memory mode", () => {
    expect(resolveDatabaseTarget("memory")).toEqual({ driver: "memory" });
    expect(resolveDatabaseTarget(":memory:")).toEqual({ driver: "memory" });
    expect(resolveDatabaseTarget("sqlite::memory:")).toEqual({
      driver: "memory",
    });
    expect(resolveDatabaseTarget("", ":memory:")).toEqual({
      driver: "memory",
    });
  });
});
