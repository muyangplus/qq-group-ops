import { describe, expect, it } from "vitest";

import { loadAdminApiConfig } from "../src/adminApi/config.js";
import { WindowRateLimiter } from "../src/adminApi/rateLimit.js";
import {
  ADMIN_SESSION_COOKIE,
  buildAdminApiServer,
  readCookie,
  sessionCookie,
} from "../src/adminApi/server.js";
import type { AdminTokenRepository } from "../src/db/adminTokenRepository.js";

/**
 * 管理 API 的 HTTP 层（E1-a，认证方案 B2）。
 *
 * 关注点：公开端点只有 `/healthz` 与 `/auth/token`；其余要会话 cookie；写操作要 CSRF 头；
 * 令牌只能用一次；限流生效。日志不带凭据由 server 层保证（这里只断言响应行为）。
 */

const CONFIG = loadAdminApiConfig({
  ADMIN_API_ENABLED: "true",
  ADMIN_API_SESSION_SECRET: "y".repeat(40),
  ADMIN_API_PUBLIC_BASE_URL: "https://ops.example.com",
});

/** 内存版令牌仓储：一次性 + TTL（SQL 版由 test/adminTokenRepository.test.ts 覆盖）。 */
function memoryTokens(ttlMs = 60_000): AdminTokenRepository {
  const rows = new Map<
    string,
    { userId: string; expiresAt: number; used: boolean }
  >();
  return {
    async issue({ userId, now }) {
      const token = `tok-${rows.size + 1}`;
      const expiresAt = new Date((now?.getTime() ?? Date.now()) + ttlMs);
      rows.set(token, { userId, expiresAt: expiresAt.getTime(), used: false });
      return { token, expiresAt };
    },
    async redeem(token, now) {
      const row = rows.get(token.trim());
      if (!row || row.used) {
        return undefined;
      }
      if (row.expiresAt <= (now?.getTime() ?? Date.now())) {
        return undefined;
      }
      row.used = true;
      return row.userId;
    },
    async pruneExpired() {
      // 内存版无需清理
    },
  };
}

function build(options: { limitPerMinute?: number } = {}) {
  const tokens = memoryTokens();
  const server = buildAdminApiServer({
    config: { ...CONFIG, rateLimitPerMinute: options.limitPerMinute ?? 60 },
    tokens,
    version: "test",
  });
  return { ...server, tokens };
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return header.split(";")[0] ?? "";
}

describe("管理 API HTTP 层", () => {
  it("/healthz 免鉴权且不暴露敏感信息", async () => {
    const { app } = build();

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, version: "test" });
    await app.close();
  });

  it("未登录访问受保护端点返回 401", async () => {
    const { app } = build();

    const response = await app.inject({ method: "GET", url: "/auth/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthorized" });
    await app.close();
  });

  it("兑换：缺 CSRF 头 403、坏令牌 401、好令牌 200 且只能用一次", async () => {
    const { app, tokens } = build();
    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });

    const noCsrf = await app.inject({
      method: "POST",
      url: "/auth/token",
      payload: { token },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: "csrf" });

    const bad = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: "不存在" },
    });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ userId: "op1" });
    const cookie = cookieOf(ok);

    // 一次性：同一个令牌再兑换一次失败
    const replay = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    expect(replay.statusCode).toBe(401);

    // 带会话 cookie 可以访问 /auth/me
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ userId: "op1" });

    await app.close();
  });

  it("写操作要 CSRF 头；登出后会话立即失效", async () => {
    const { app, tokens } = build();
    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const noCsrf = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(logout.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);

    await app.close();
  });

  it("会话级限流：超过每分钟上限返回 429", async () => {
    const { app, tokens } = build({ limitPerMinute: 1 });
    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const first = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: "rate_limited" });

    await app.close();
  });

  it("/api/status 需要登录，返回只读状态", async () => {
    const { app, tokens } = build();
    const unauth = await app.inject({ method: "GET", url: "/api/status" });
    expect(unauth.statusCode).toBe(401);

    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: "test", sessions: 1 });

    await app.close();
  });

  it("/api/audit 需要登录，支持按群/操作人/动作过滤与分页", async () => {
    const tokens = memoryTokens();
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      auditReader: {
        list: async () =>
          Array.from({ length: 5 }, (_value, index) => ({
            recordId: `r${index}`,
            groupId: index % 2 === 0 ? "g1" : "g2",
            actorId: index === 0 ? "op1" : "op2",
            action: index < 3 ? "approve_join_request" : "reject_join_request",
            status: "executed",
            reason: "",
            createdAt: "2026-10-01T00:00:00.000Z",
          })),
      },
    }).app;

    const unauth = await app.inject({ method: "GET", url: "/api/audit" });
    expect(unauth.statusCode).toBe(401);

    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const filtered = await app.inject({
      method: "GET",
      url: "/api/audit?group=g1&pageSize=10",
      headers: { cookie },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({ total: 3, page: 1, pageSize: 10 });
    expect(filtered.json<{ items: unknown[] }>().items).toHaveLength(3);

    const paged = await app.inject({
      method: "GET",
      url: "/api/audit?page=2&pageSize=2",
      headers: { cookie },
    });
    expect(paged.json()).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(paged.json<{ items: unknown[] }>().items).toHaveLength(2);

    await app.close();
  });

  it("审计数据源未装配时回 503", async () => {
    const { app, tokens } = build();
    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: cookieOf(login) },
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("登录链接按 PUBLIC_BASE_URL 拼", async () => {
    const { app, loginUrl } = build();
    expect(loginUrl("tok")).toBe("https://ops.example.com/login?token=tok");
    await app.close();
  });
});

describe("cookie 工具", () => {
  it("解析与序列化", () => {
    expect(
      readCookie(`${ADMIN_SESSION_COOKIE}=abc.def; other=1`, ADMIN_SESSION_COOKIE),
    ).toBe("abc.def");
    expect(readCookie("garbage", ADMIN_SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, ADMIN_SESSION_COOKIE)).toBeUndefined();

    const cookie = sessionCookie("v", CONFIG);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
    expect(sessionCookie("", CONFIG, 0)).toContain("Max-Age=0");
  });
});

describe("WindowRateLimiter（HTTP 层用到的实例）", () => {
  it("limit = 0 表示不限", () => {
    const limiter = new WindowRateLimiter({ limitPerWindow: 0 });
    expect(limiter.allow("s1")).toBe(true);
    expect(limiter.allow("s1")).toBe(true);
  });
});
