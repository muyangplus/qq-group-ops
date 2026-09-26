import { describe, expect, it } from "vitest";

import {
  DEFAULT_SQLITE_PATH,
  hasQqCredentials,
  loadSettings,
  resolveDatabaseTarget,
  resolveEventMode,
  resolveMenuFirstPushMode,
  resolveWebhookKeyDerivation,
  resolveWebhookSignContent,
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

    // 密钥派生 / 拼接顺序：默认即官方算法，显式值可切换
    expect(defaults.webhookKeyDerivation).toBe("auto");
    expect(defaults.webhookSignContent).toBe("ts_token");
    expect(resolveWebhookKeyDerivation(undefined)).toBe("auto");
    expect(resolveWebhookKeyDerivation("   ")).toBe("auto");
    expect(resolveWebhookKeyDerivation("HEX")).toBe("hex");
    expect(resolveWebhookKeyDerivation("sha256")).toBe("sha256");
    expect(() => resolveWebhookKeyDerivation("raw")).toThrow("WEBHOOK_KEY_DERIVATION");
    expect(resolveWebhookSignContent(undefined)).toBe("ts_token");
    expect(resolveWebhookSignContent("TOKEN_TS")).toBe("token_ts");
    expect(() => resolveWebhookSignContent("body_ts")).toThrow("WEBHOOK_SIGN_CONTENT");
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

describe("resolveMenuFirstPushMode", () => {
  it("defaults to persistent and accepts explicit modes", () => {
    expect(resolveMenuFirstPushMode(undefined)).toBe("persistent");
    expect(resolveMenuFirstPushMode("")).toBe("persistent");
    expect(resolveMenuFirstPushMode("persistent")).toBe("persistent");
    expect(resolveMenuFirstPushMode("db")).toBe("persistent");
    expect(resolveMenuFirstPushMode("memory")).toBe("memory");
    expect(resolveMenuFirstPushMode("MEM")).toBe("memory");
  });

  it("rejects unknown modes instead of silently falling back", () => {
    expect(() => resolveMenuFirstPushMode("memroy")).toThrow(
      /MENU_FIRST_PUSH/u,
    );
  });
});
