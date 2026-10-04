import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import {
  adminLoginUrl,
  DEFAULT_ADMIN_API_PORT,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_TOKEN_TTL_MS,
  loadAdminApiConfig,
  machineTokenAllows,
  parseMachineTokens,
  readAdminApiHotConfig,
} from "../src/adminApi/config.js";
import { WindowRateLimiter } from "../src/adminApi/rateLimit.js";
import { SessionStore } from "../src/adminApi/session.js";
import type {
  PlatformSetting,
  PlatformSettingsRepository,
} from "../src/db/platformSettingsRepository.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";

/**
 * E1-a 骨架：配置解析、会话、限流。
 *
 * 认证方案 B2：机器人私信一次性令牌 + 会话 cookie（没有账号与口令）。
 */

const SECRET = "x".repeat(40);
const USER = "op1";

class FakeRepository implements PlatformSettingsRepository {
  public readonly rows = new Map<string, string>();

  public async findAll(): Promise<PlatformSetting[]> {
    return [...this.rows.entries()].map(([key, value]) => ({ key, value }));
  }

  public async save(setting: PlatformSetting): Promise<void> {
    this.rows.set(setting.key, setting.value);
  }

  public async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

describe("loadAdminApiConfig", () => {
  it("默认关闭，且只监听本机", () => {
    const config = loadAdminApiConfig({});

    expect(config.enabled).toBe(false);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(DEFAULT_ADMIN_API_PORT);
    expect(config.cookieSecure).toBe(false);
    expect(config.allowedOpenIds).toEqual([]);
  });

  it("关闭时不校验会话密钥（机器人进程不需要为它准备配置）", () => {
    expect(() => loadAdminApiConfig({ ADMIN_API_ENABLED: "false" })).not.toThrow();
  });

  it("开启时缺会话密钥直接拒绝启动（fail-closed）", () => {
    expect(() => loadAdminApiConfig({ ADMIN_API_ENABLED: "true" })).toThrow(
      /ADMIN_API_SESSION_SECRET/u,
    );
  });

  it("开启时读全量核心配置（TTL / 限流是热改项，不在这里读）", () => {
    const config = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: SECRET,
      ADMIN_API_HOST: "0.0.0.0",
      ADMIN_API_PORT: "9000",
      ADMIN_API_COOKIE_SECURE: "true",
      ADMIN_API_PUBLIC_BASE_URL: "https://ops.example.com/",
      ADMIN_API_ALLOWED_OPENIDS: "op1, op2 ,",
      // ADR-0066：这三项已经搬进系统配置（热改项）——`.env` 里写了也不再读，
      // 默认值来自代码，运行期值以库为准（见下面的「管理 API 热配置」）
      ADMIN_API_TOKEN_TTL_MINUTES: "3",
      ADMIN_API_SESSION_TTL_MINUTES: "60",
      ADMIN_API_RATE_LIMIT_PER_MINUTE: "0",
    });

    expect(config.enabled).toBe(true);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.cookieSecure).toBe(true);
    expect(config.tokenTtlMs).toBe(DEFAULT_TOKEN_TTL_MS);
    expect(config.sessionTtlMs).toBe(DEFAULT_SESSION_TTL_MS);
    expect(config.allowedOpenIds).toEqual(["op1", "op2"]);
    expect(config.rateLimitPerMinute).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
  });

  it("解析机器令牌：长度 / scope / 到期时间，过期即不可用", () => {
    const parsed = parseMachineTokens(
      "abcdef0123456789:read,abcdef9876543210:read|write:2027-01-01T00:00:00Z,short:read,abcdef0000000000",
    );

    expect(parsed.tokens).toHaveLength(2);
    expect(parsed.tokens[0]).toMatchObject({
      token: "abcdef0123456789",
      scopes: ["read"],
    });
    expect(parsed.tokens[1]?.expiresAt?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(parsed.issues).toHaveLength(2);

    const valid = { token: "x".repeat(16), scopes: ["read"] };
    expect(machineTokenAllows(valid, "read")).toBe(true);
    expect(machineTokenAllows(valid, "write")).toBe(false);
    expect(machineTokenAllows({ token: "x".repeat(16), scopes: ["*"] }, "write")).toBe(
      true,
    );
    const expired = {
      token: "x".repeat(16),
      scopes: ["read"],
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    };
    expect(
      machineTokenAllows(expired, "read", new Date("2026-01-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("登录链接只在配了 PUBLIC_BASE_URL 时给（并去掉尾斜杠）", () => {
    const withBase = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: SECRET,
      ADMIN_API_PUBLIC_BASE_URL: "https://ops.example.com/",
    });
    expect(adminLoginUrl(withBase, "tok")).toBe(
      "https://ops.example.com/login?token=tok",
    );

    const noBase = loadAdminApiConfig({});
    expect(adminLoginUrl(noBase, "tok")).toBeUndefined();
  });
});

/**
 * ADR-0066：会话 TTL / 令牌 TTL / 限流三项从 `.env` 搬进系统配置，
 * 读点一律「用的时候取当前值」—— 这里同时守住换算与「改完立即生效」。
 */
describe("管理 API 热配置", () => {
  it("readAdminApiHotConfig 读出当前值（分钟 → 毫秒）", async () => {
    const store = new PlatformSettingsStore(
      loadSettings({ ADMIN_API_SESSION_TTL_MINUTES: "1" }),
      new FakeRepository(),
    );
    await store.load();
    // 内置默认：720 分钟 / 10 分钟 / 60 次
    expect(readAdminApiHotConfig(store)).toEqual({
      sessionTtlMs: 720 * 60_000,
      tokenTtlMs: 10 * 60_000,
      rateLimitPerMinute: 60,
    });

    await store.set("adminApiSessionTtlMinutes", "30");
    await store.set("adminApiTokenTtlMinutes", "5");
    await store.set("adminApiRateLimitPerMinute", "0");

    expect(readAdminApiHotConfig(store)).toEqual({
      sessionTtlMs: 30 * 60_000,
      tokenTtlMs: 5 * 60_000,
      rateLimitPerMinute: 0,
    });
  });

  it("会话过期判定按当前 TTL（会话中调大就立刻续得上）", () => {
    let ttlMs = 1_000;
    let now = 1_000;
    const store = new SessionStore({
      secret: SECRET,
      ttlMs: () => ttlMs,
      now: () => now,
    });
    const first = store.create(USER);
    now += 5_000;
    expect(store.touch(first.cookieValue)).toBeUndefined();

    // 改成 1 小时后新建的会话按新值判定（旧会话早已过期，不受影响）
    ttlMs = 60 * 60 * 1000;
    const second = store.create(USER);
    now += 30 * 60 * 1000;
    expect(store.touch(second.cookieValue)?.userId).toBe(USER);
  });

  it("限流按当前上限判定（改成 0 = 立即不限）", () => {
    let limit = 1;
    const now = 1_000;
    const limiter = new WindowRateLimiter({
      limitPerWindow: () => limit,
      windowMs: 60_000,
      now: () => now,
    });
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);

    limit = 0;
    expect(limiter.allow("k")).toBe(true);

    limit = 2;
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
  });
});

describe("SessionStore", () => {
  it("签名保护：改一个字符就失效", () => {
    const store = new SessionStore({ secret: SECRET, ttlMs: 60_000 });
    const { cookieValue } = store.create(USER);

    expect(store.touch(cookieValue)?.userId).toBe(USER);
    expect(store.touch(`${cookieValue}x`)).toBeUndefined();
    expect(store.touch("garbage")).toBeUndefined();
    expect(store.touch(undefined)).toBeUndefined();
  });

  it("滑动过期：TTL 内每次访问都续期，超时后失效", () => {
    let now = 1_000;
    const store = new SessionStore({
      secret: SECRET,
      ttlMs: 1_000,
      now: () => now,
    });
    const { cookieValue } = store.create(USER);

    now = 1_500;
    expect(store.touch(cookieValue)).toBeDefined();
    now = 2_400; // 距上次访问 900ms < TTL
    expect(store.touch(cookieValue)).toBeDefined();
    now = 3_500; // 距上次访问 1100ms > TTL
    expect(store.touch(cookieValue)).toBeUndefined();
  });

  it("登出只删自己的会话，clear 清空全部", () => {
    const store = new SessionStore({ secret: SECRET, ttlMs: 60_000 });
    const first = store.create(USER);
    const second = store.create(USER);

    expect(store.destroy(first.cookieValue)).toBe(true);
    expect(store.touch(first.cookieValue)).toBeUndefined();
    expect(store.touch(second.cookieValue)).toBeDefined();
    expect(store.clear()).toBe(1);
    expect(store.touch(second.cookieValue)).toBeUndefined();
  });

  it("超出上限时淘汰最久未使用的会话", () => {
    let now = 0;
    const store = new SessionStore({
      secret: SECRET,
      ttlMs: 60_000,
      maxSessions: 2,
      now: () => now,
    });
    const first = store.create(USER);
    now = 10;
    const second = store.create(USER);
    now = 20;
    const third = store.create(USER);

    expect(store.touch(first.cookieValue)).toBeUndefined();
    expect(store.touch(second.cookieValue)).toBeDefined();
    expect(store.touch(third.cookieValue)).toBeDefined();
  });
});

describe("WindowRateLimiter", () => {
  it("窗口内超限即拒绝，窗口滑过后恢复", () => {
    let now = 0;
    const limiter = new WindowRateLimiter({
      limitPerWindow: 2,
      windowMs: 1_000,
      now: () => now,
    });

    expect(limiter.allow("s1")).toBe(true);
    expect(limiter.allow("s1")).toBe(true);
    expect(limiter.allow("s1")).toBe(false);
    expect(limiter.used("s1")).toBe(2);
    // 另一个会话不受影响
    expect(limiter.allow("s2")).toBe(true);

    now = 1_001;
    expect(limiter.allow("s1")).toBe(true);
  });

  it("limit = 0 表示不限", () => {
    const limiter = new WindowRateLimiter({ limitPerWindow: 0 });
    for (let index = 0; index < 100; index += 1) {
      expect(limiter.allow("s1")).toBe(true);
    }
  });
});
