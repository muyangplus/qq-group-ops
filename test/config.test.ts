import { describe, expect, it } from "vitest";

import {
  DEFAULT_SQLITE_PATH,
  hasQqCredentials,
  loadSettings,
  resolveDatabaseTarget,
  resolveEventMode,
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
    // 正式启动默认入库持久化；dev 入口会把这个值覆盖成 memory
    expect(settings.menuFirstPush).toBe("persistent");
  });

  it("resolves the event mode and webhook settings (§D5)", () => {
    // 默认 websocket，保持既有部署行为
    expect(resolveEventMode(undefined)).toBe("websocket");
    expect(resolveEventMode("")).toBe("websocket");
    expect(resolveEventMode("ws")).toBe("websocket");
    expect(resolveEventMode("WebHook")).toBe("webhook");
    expect(() => resolveEventMode("socket")).toThrow("EVENT_MODE");

    const defaults = loadSettings({});
    expect(defaults.eventMode).toBe("websocket");
    expect(defaults.webhookPort).toBe(3000);
    expect(defaults.webhookHost).toBe("127.0.0.1");
    expect(defaults.webhookPath).toBe("/webhook/qq");
    expect(defaults.webhookSecret).toBe("");

    const webhook = loadSettings({
      EVENT_MODE: "webhook",
      WEBHOOK_PORT: "8443",
      WEBHOOK_HOST: "0.0.0.0",
      WEBHOOK_PATH: "/cb/qq",
      WEBHOOK_SECRET: " 回调密钥 ",
      QQ_BOT_CLIENT_SECRET: "机器人密钥",
    });
    expect(webhook.eventMode).toBe("webhook");
    expect(webhook.webhookPort).toBe(8443);
    expect(webhook.webhookHost).toBe("0.0.0.0");
    expect(webhook.webhookPath).toBe("/cb/qq");
    // 显式 WEBHOOK_SECRET 优先，并去掉首尾空白
    expect(webhook.webhookSecret).toBe("回调密钥");

    // 没填 WEBHOOK_SECRET 时回落到机器人密钥
    expect(loadSettings({ QQ_BOT_CLIENT_SECRET: "机器人密钥" }).webhookSecret).toBe(
      "机器人密钥",
    );
    // 真机踩过：`.env` 里写 `WEBHOOK_SECRET=`（空字符串）也必须回落到机器人密钥，
    // 用 `??` 会卡在空串上，导致 webhook 模式直接启动失败
    expect(
      loadSettings({
        WEBHOOK_SECRET: "",
        QQ_BOT_CLIENT_SECRET: "机器人密钥",
      }).webhookSecret,
    ).toBe("机器人密钥");
    expect(
      loadSettings({
        WEBHOOK_SECRET: "   ",
        QQ_BOT_CLIENT_SECRET: "机器人密钥",
      }).webhookSecret,
    ).toBe("机器人密钥");
    // 两个都空 → 空串，由 main 明确报错
    expect(
      loadSettings({ WEBHOOK_SECRET: "", QQ_BOT_CLIENT_SECRET: "" }).webhookSecret,
    ).toBe("");
  });

  it("loads environment values", () => {
    const settings = loadSettings({
      QQ_BOT_APP_ID: "123",
      QQ_BOT_CLIENT_SECRET: "secret",
      QQ_BOT_SANDBOX: "true",
      ADMIN_USER_IDS: "1, 2",
      LOG_FILE: "custom.log",
      LOG_CONSOLE: "false",
      LOG_COLOR: "never",
    });
    expect(hasQqCredentials(settings)).toBe(true);
    expect(settings.qqBotSandbox).toBe(true);
    expect(settings.adminUserIds).toEqual(["1", "2"]);
    expect(settings.logFile).toBe("custom.log");
    expect(settings.logConsole).toBe(false);
    expect(settings.logColor).toBe("never");
  });

  it("不再认旧名 ADMIN_QQ_IDS（只认 ADMIN_USER_IDS）", () => {
    const settings = loadSettings({ ADMIN_QQ_IDS: "legacy" } as NodeJS.ProcessEnv);
    expect(settings.adminUserIds).toEqual([]);
  });

  /**
   * ADR-0066：热改项的默认值搬进了代码，`.env` 只在启动时被导入一次（见
   * `settingsImport.test.ts`）—— 所以 `loadSettings` 读到这些环境变量时必须**原样忽略**，
   * 否则「删掉 `.env` 里的行」与「留着」就会出现两套行为。
   */
  it("热改项不再从环境变量读（只当启动时的导入来源）", () => {
    const base = loadSettings({});
    const polluted = loadSettings({
      RAW_MESSAGE_RETENTION_DAYS: "7",
      AUDIT_LOG_RETENTION_DAYS: "1",
      JOIN_REQUEST_TTL_DAYS: "3",
      MENU_FIRST_PUSH: "memory",
      ACTIVITY_NOTIFY_DAILY_LIMIT: "99",
      ACTIVITY_NOTIFY_RATE_PER_SECOND: "20",
      APPEAL_HOLD_MINUTES: "1",
      SCAN_INTERVAL_MS: "5000",
      AUTO_RESTART_ON_DEPLOY: "0",
      DEPLOY_RESTART_DELAY_MINUTES: "1",
      DEPLOY_CHECK_INTERVAL_MS: "2000",
      JOIN_SYNC_INTERVAL_MS: "1000",
      SCHEDULED_ANNOUNCE_ENABLED: "1",
      SCHEDULED_ANNOUNCE_HOURLY_LIMIT: "99",
      ACTIVITY_STATS_FONT_URL: "https://example.com/font.otf",
      ADMIN_API_SESSION_TTL_MINUTES: "5",
      ADMIN_API_TOKEN_TTL_MINUTES: "3",
      ADMIN_API_RATE_LIMIT_PER_MINUTE: "0",
    });

    for (const key of [
      "rawMessageRetentionDays",
      "auditLogRetentionDays",
      "joinRequestTtlDays",
      "menuFirstPush",
      "activityNotifyDailyLimit",
      "activityNotifyRatePerSecond",
      "appealHoldMinutes",
      "scanIntervalMs",
      "autoRestartOnDeploy",
      "deployRestartDelayMinutes",
      "deployCheckIntervalMs",
      "joinSyncIntervalMs",
      "scheduledAnnounceEnabled",
      "scheduledAnnounceHourlyLimit",
      "activityStatsFontUrl",
      "adminApiSessionTtlMinutes",
      "adminApiTokenTtlMinutes",
      "adminApiRateLimitPerMinute",
    ] as const) {
      expect(polluted[key], key).toEqual(base[key]);
    }

    // 唯一例外：`TZ` 是「连库之前就要用」的核心项，仍然从 `.env` 读（同时可被覆盖）
    expect(loadSettings({ TZ: "UTC" }).displayTimezone).toBe("UTC");
    expect(loadSettings({ TZ: "  " }).displayTimezone).toBe(base.displayTimezone);
  });
});

describe("resolveDatabaseTarget", () => {  it("defaults to a SQLite file", () => {
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
