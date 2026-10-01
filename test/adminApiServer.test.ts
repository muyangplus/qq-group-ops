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
    async countActive() {
      let count = 0;
      for (const row of rows.values()) {
        if (!row.used && row.expiresAt > Date.now()) {
          count += 1;
        }
      }
      return count;
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

  it("/api/pending 需要登录，可按群过滤 + 分页", async () => {
    const tokens = memoryTokens();
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      readers: {
        pending: async () =>
          Array.from({ length: 4 }, (_value, index) => ({
            requestId: `r${index}`,
            groupId: index < 3 ? "g1" : "g2",
            userId: `u${index}`,
            reason: "想加入",
            createdAt: "2026-10-01T00:00:00.000Z",
          })),
        rules: async (groupId: string) => ({
          groupId,
          override: null,
          settings: [],
        }),
      },
    }).app;

    const unauth = await app.inject({ method: "GET", url: "/api/pending" });
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
      url: "/api/pending?group=g1",
      headers: { cookie },
    });
    expect(filtered.json()).toMatchObject({ total: 3, page: 1 });
    expect(filtered.json<{ items: unknown[] }>().items).toHaveLength(3);

    const paged = await app.inject({
      method: "GET",
      url: "/api/pending?page=2&pageSize=1",
      headers: { cookie },
    });
    expect(paged.json()).toMatchObject({ total: 4, page: 2, pageSize: 1 });
    expect(paged.json<{ items: unknown[] }>().items).toHaveLength(1);

    await app.close();
  });

  it("/api/rules 需要 ?group=，缺参数 400；无数据源 503", async () => {
    const tokens = memoryTokens();
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      readers: {
        pending: async () => [],
        rules: async (groupId: string) => ({
          groupId,
          override: { groupId, warningMessage: "本群文案" },
          settings: [{ key: "punishActions", value: "{}" }],
        }),
      },
    }).app;
    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const missing = await app.inject({
      method: "GET",
      url: "/api/rules",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "bad_request" });

    const ok = await app.inject({
      method: "GET",
      url: "/api/rules?group=g1",
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ groupId: "g1" });
    expect(ok.json<{ settings: unknown[] }>().settings).toHaveLength(1);

    await app.close();

    const bare = build().app;
    const bareTokens = memoryTokens();
    const bareApp = buildAdminApiServer({ config: CONFIG, tokens: bareTokens, version: "test" }).app;
    const issued = await bareTokens.issue({ userId: "op1", ttlMs: 60_000 });
    const bareLogin = await bareApp.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: issued.token },
    });
    const unavailable = await bareApp.inject({
      method: "GET",
      url: "/api/pending",
      headers: { cookie: cookieOf(bareLogin) },
    });
    expect(unavailable.statusCode).toBe(503);
    await bare.close();
    await bareApp.close();
  });

  it("/api/notify/topics 返回默认门槛与订阅人数（无数据源 503）", async () => {
    const tokens = memoryTokens();
    const readers = {
      pending: async () => [],
      rules: async (groupId: string) => ({ groupId, override: null, settings: [] }),
      notifyTopics: async () => [
        { topic: "join", label: "入群申请", defaultLevel: 130, allScope: 2, groupScopes: 5 },
      ],
    };
    const app = buildAdminApiServer({ config: CONFIG, tokens, version: "test", readers }).app;
    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/notify/topics",
      headers: { cookie: cookieOf(login) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      topics: [
        { topic: "join", label: "入群申请", defaultLevel: 130, allScope: 2, groupScopes: 5 },
      ],
    });
    await app.close();

    const bareTokens = memoryTokens();
    const bareApp = buildAdminApiServer({
      config: CONFIG,
      tokens: bareTokens,
      version: "test",
    }).app;
    const issued = await bareTokens.issue({ userId: "op1", ttlMs: 60_000 });
    const bareLogin = await bareApp.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: issued.token },
    });
    const unavailable = await bareApp.inject({
      method: "GET",
      url: "/api/notify/topics",
      headers: { cookie: cookieOf(bareLogin) },
    });
    expect(unavailable.statusCode).toBe(503);
    await bareApp.close();
  });

  it("/api/activities 需要登录，可按群/状态过滤 + 分页", async () => {
    const tokens = memoryTokens();
    const readers = {
      pending: async () => [],
      rules: async (groupId: string) => ({ groupId, override: null, settings: [] }),
      notifyTopics: async () => [],
      activities: async () => [
        {
          activityId: "a1",
          code: "ACT001",
          title: "春游",
          groupId: "g1",
          status: "open",
          registered: 3,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
        {
          activityId: "a2",
          code: "ACT002",
          title: "秋游",
          groupId: "g2",
          status: "closed",
          registered: 1,
          createdAt: "2026-10-02T00:00:00.000Z",
        },
      ],
    };
    const app = buildAdminApiServer({ config: CONFIG, tokens, version: "test", readers }).app;

    const unauth = await app.inject({ method: "GET", url: "/api/activities" });
    expect(unauth.statusCode).toBe(401);

    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const byGroup = await app.inject({
      method: "GET",
      url: "/api/activities?group=g1&status=open",
      headers: { cookie },
    });
    expect(byGroup.json()).toMatchObject({ total: 1, page: 1 });
    expect(byGroup.json<{ items: Array<{ code: string }> }>().items[0]?.code).toBe(
      "ACT001",
    );

    const all = await app.inject({
      method: "GET",
      url: "/api/activities?pageSize=1",
      headers: { cookie },
    });
    expect(all.json()).toMatchObject({ total: 2, pageSize: 1 });
    expect(all.json<{ items: unknown[] }>().items).toHaveLength(1);

    await app.close();
  });

  it("机器令牌：Bearer + scope（read 读 / write 写 / 缺 scope 403 / 假令牌 401）", async () => {
    const tokens = memoryTokens();
    const config = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: "m".repeat(40),
      ADMIN_API_TOKENS:
        "readonly-token-1234:read,writer-token-5678:write",
    });
    const app = buildAdminApiServer({ config, tokens, version: "test" }).app;

    const read = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer readonly-token-1234" },
    });
    expect(read.statusCode).toBe(200);

    // 只有 write scope，读接口拒
    const scopeDenied = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer writer-token-5678" },
    });
    expect(scopeDenied.statusCode).toBe(403);
    expect(scopeDenied.json()).toMatchObject({ error: "forbidden" });

    // 只有 read scope，写接口拒
    const writeDenied = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: "Bearer readonly-token-1234" },
    });
    expect(writeDenied.statusCode).toBe(403);

    // write scope + 无需 CSRF 头（机器调用没有 cookie）
    const writeOk = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: "Bearer writer-token-5678" },
    });
    expect(writeOk.statusCode).toBe(200);

    const bogus = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer 不存在的令牌" },
    });
    expect(bogus.statusCode).toBe(401);

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
