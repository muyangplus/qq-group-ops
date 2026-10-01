import { describe, expect, it } from "vitest";

import {
  adminLoginUrl,
  DEFAULT_ADMIN_API_PORT,
  loadAdminApiConfig,
} from "../src/adminApi/config.js";
import { WindowRateLimiter } from "../src/adminApi/rateLimit.js";
import { SessionStore } from "../src/adminApi/session.js";

/**
 * E1-a 骨架：配置解析、会话、限流。
 *
 * 认证方案 B2：机器人私信一次性令牌 + 会话 cookie（没有账号与口令）。
 */

const SECRET = "x".repeat(40);
const USER = "op1";

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

  it("开启时读全量配置（含白名单与令牌 TTL）", () => {
    const config = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: SECRET,
      ADMIN_API_HOST: "0.0.0.0",
      ADMIN_API_PORT: "9000",
      ADMIN_API_COOKIE_SECURE: "true",
      ADMIN_API_PUBLIC_BASE_URL: "https://ops.example.com/",
      ADMIN_API_TOKEN_TTL_MINUTES: "3",
      ADMIN_API_SESSION_TTL_MINUTES: "60",
      ADMIN_API_ALLOWED_OPENIDS: "op1, op2 ,",
      ADMIN_API_RATE_LIMIT_PER_MINUTE: "0",
    });

    expect(config.enabled).toBe(true);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.cookieSecure).toBe(true);
    expect(config.tokenTtlMs).toBe(3 * 60 * 1000);
    expect(config.sessionTtlMs).toBe(60 * 60 * 1000);
    expect(config.allowedOpenIds).toEqual(["op1", "op2"]);
    expect(config.rateLimitPerMinute).toBe(0);
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
