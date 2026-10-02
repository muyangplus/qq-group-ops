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

/** 展示层字段（E2-e）：HTTP 层测试只关心响应形状，给最小可用的 ref（真值由后端解析）。 */
const groupRef = (groupId: string) => ({
  kind: "group" as const,
  officialId: groupId,
  label: groupId,
});
const userRef = (userId: string) => ({
  kind: "user" as const,
  officialId: userId,
  label: userId,
});
const requestRef = (requestId: string) => ({
  kind: "request" as const,
  officialId: requestId,
  label: requestId,
});

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

  it("/api/tasks 需要平台超管；只读巡检（没调度器）回 503", async () => {
    const tokens = memoryTokens();
    const view = {
      intervalMs: 60_000,
      started: true,
      tasks: [
        {
          name: "deploy-watcher",
          minIntervalMs: 60_000,
          runOnStart: true,
          enabled: true,
          lastRunAt: "2026-10-02T00:00:00.000Z",
          nextRunAt: "2026-10-02T00:01:00.000Z",
        },
      ],
      deploy: {
        targetVersion: "0.24.0",
        currentVersion: "0.23.2",
        detectedAt: "2026-10-02T00:00:00.000Z",
        deadlineAt: "2026-10-02T00:10:00.000Z",
      },
    };
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      tasksProvider: () => view,
    }).app;

    const unauth = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(unauth.statusCode).toBe(401);

    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const ok = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      intervalMs: 60_000,
      started: true,
      tasks: [{ name: "deploy-watcher", enabled: true }],
      deploy: { targetVersion: "0.24.0", currentVersion: "0.23.2" },
    });

    await app.close();

    // 只读巡检进程没有调度器 → 明确回 503，而不是给一份空列表（空列表会被误读成「没有任务」）
    const bare = buildAdminApiServer({ config: CONFIG, tokens }).app;
    const bareToken = await tokens.issue({ userId: "op2", ttlMs: 60_000 });
    const bareLogin = await bare.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: bareToken.token },
    });
    const bareResponse = await bare.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { cookie: cookieOf(bareLogin) },
    });
    expect(bareResponse.statusCode).toBe(503);
    expect(bareResponse.json().message).toContain("周期任务调度器");
    await bare.close();
  });

  it("P1 只读端点：门槛与「未装配回 503」都按口径", async () => {
    // ① 未装配（只读巡检模式）：明确 503，而不是假装空列表
    const bareTokens = memoryTokens();
    const bare = buildAdminApiServer({ config: CONFIG, tokens: bareTokens }).app;
    const bareToken = await bareTokens.issue({ userId: "op1", ttlMs: 60_000 });
    const bareLogin = await bare.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: bareToken.token },
    });
    const bareCookie = cookieOf(bareLogin);
    for (const url of [
      "/api/punishments",
      "/api/blacklist?group=g1",
      "/api/appeals",
      "/api/notify/deliveries",
      "/api/health",
    ]) {
      const response = await bare.inject({
        method: "GET",
        url,
        headers: { cookie: bareCookie },
      });
      expect(response.statusCode, url).toBe(503);
    }
    await bare.close();

    // ② 装配了数据源 + 非平台超管：不传 group 一律 400（与 /api/audit 同一口径）
    const tokens = memoryTokens();
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      readers: {
        punishments: async () => [
          {
            recordId: "ABC123",
            code: "#ABC123",
            groupId: "g1",
            group: groupRef("g1"),
            userId: "u1",
            target: userRef("u1"),
            actorId: "mod",
            actor: userRef("mod"),
            source: "manual",
            ruleReason: "广告",
            messageExcerpt: "",
            actions: "警告",
            detail: "",
            status: "active",
            createdAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
          },
        ],
        blacklist: async (groupId, options) => ({
          groupId,
          group: groupRef(groupId),
          entries: [],
          globalEntries: options.includeGlobal ? [] : [],
          globalVisible: options.includeGlobal,
        }),
        appeals: async () => ({ items: [], holdMinutes: 15, pendingCount: 0 }),
        deliveries: async () => [],
        health: async () => ({
          process: {
            runningVersion: "0.24.1",
            diskVersion: "0.24.1",
            uptimeMs: 1000,
            startedAt: "2026-10-02T00:00:00.000Z",
            pid: 1,
            node: "v24.0.0",
            platform: "linux",
            arch: "x64",
            rss: 1,
            heapUsed: 1,
            heapTotal: 1,
            mode: "fake",
          },
          database: { driver: "memory", migrationIssues: [] },
          queue: { pending: 0, failures: 0 },
          notify: { subscribers: 0, deliveries: 0 },
          modules: [],
          restart: { brokenBuild: false },
        }),
      },
      readAccessOf: async (userId) => ({
        platformLevel: userId === "boss" ? 240 : 0,
        groups: [{ groupId: "g1", level: 120 }],
      }),
    }).app;
    const readToken = await tokens.issue({ userId: "mod", ttlMs: 60_000 });
    const readLogin = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: readToken.token },
    });
    const modCookie = cookieOf(readLogin);

    for (const url of ["/api/punishments", "/api/appeals", "/api/notify/deliveries"]) {
      const missing = await app.inject({
        method: "GET",
        url,
        headers: { cookie: modCookie },
      });
      expect(missing.statusCode, url).toBe(400);
    }
    // 带上 group 且有 120：放行
    const ok = await app.inject({
      method: "GET",
      url: "/api/punishments?group=g1",
      headers: { cookie: modCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ total: 1 });
    // 黑名单缺 group 也是 400（它是群维度）
    const blacklistMissing = await app.inject({
      method: "GET",
      url: "/api/blacklist",
      headers: { cookie: modCookie },
    });
    expect(blacklistMissing.statusCode).toBe(400);

    // ③ 平台级运维端点：非 240 一律 403
    const health = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { cookie: modCookie },
    });
    expect(health.statusCode).toBe(403);

    await app.close();
  });

  it("审计导出：本群 130 走 writers；没装配回 503；CSV 带 BOM", async () => {
    const tokens = memoryTokens();
    const calls: Array<{ actorId: string; group?: string; full: boolean }> = [];
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      writers: {
        syncJoinRequests: async (groupId, actorId) => ({
          groupId,
          group: groupRef(groupId),
          fetched: 0,
          pending: 0,
          message: `已同步 0 条（${actorId}）`,
        }),
        exportAuditCsv: async (actorId, options) => {
          calls.push({
            actorId,
            ...(options.group !== undefined ? { group: options.group } : {}),
            full: options.full,
          });
          return {
            filename: `audit-${options.group ?? "all"}.csv`,
            csv: "record_id\nr1\n",
            rows: 1,
            full: options.full,
          };
        },
      },
    }).app;
    const { token } = await tokens.issue({ userId: "admin", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const response = await app.inject({
      method: "GET",
      url: "/api/audit/export.csv?group=g1",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("audit-g1.csv");
    expect(response.body.startsWith("\uFEFF")).toBe(true);
    expect(calls).toEqual([{ actorId: "admin", group: "g1", full: false }]);
    await app.close();

    // 只读巡检模式不装配 writers → 503
    const bareTokens = memoryTokens();
    const bare = buildAdminApiServer({ config: CONFIG, tokens: bareTokens }).app;
    const bareToken = await bareTokens.issue({ userId: "admin", ttlMs: 60_000 });
    const bareLogin = await bare.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: bareToken.token },
    });
    const bareResponse = await bare.inject({
      method: "GET",
      url: "/api/audit/export.csv?group=g1",
      headers: { cookie: cookieOf(bareLogin) },
    });
    expect(bareResponse.statusCode).toBe(503);
    await bare.close();
  });

  it("P2 写端点：CSRF / 参数校验 / 未装配 503 都按口径", async () => {
    const tokens = memoryTokens();
    const calls: Array<Record<string, unknown>> = [];
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      writers: {
        punish: async (input) => {
          calls.push({ kind: "punish", ...input });
          return {
            ok: true,
            message: "已解除处罚",
            punishment: {
              recordId: input.code,
              code: `#${input.code}`,
              groupId: "g1",
              group: groupRef("g1"),
              userId: "u1",
              target: userRef("u1"),
              actorId: input.actorId,
              actor: userRef(input.actorId),
              source: "manual",
              ruleReason: "",
              messageExcerpt: "",
              actions: "警告",
              detail: "",
              status: "released",
              createdAt: "2026-10-02T00:00:00.000Z",
              updatedAt: "2026-10-02T00:00:00.000Z",
            },
            acceptedAppeals: 0,
          };
        },
        addBlacklist: async (input) => ({
          action: "add",
          ok: true,
          message: "已加入本群黑名单。",
          scope: input.scope,
          groupId: input.groupId ?? "",
          userId: input.userId,
          kickedGroups: 1,
        }),
        removeBlacklist: async (input) => ({
          action: "remove",
          ok: true,
          message: "已解除黑名单。",
          scope: input.scope,
          groupId: input.groupId ?? "",
          userId: input.userId,
          kickedGroups: 0,
        }),
        decideAppeal: async (input) => ({
          appeal: {
            appealId: input.code,
            code: `#${input.code}`,
            punishmentId: "ABC123",
            punishmentCode: "#ABC123",
            groupId: "g1",
            group: groupRef("g1"),
            userId: "u1",
            appellant: userRef("u1"),
            reason: "",
            status: input.decision,
            reviewerId: input.actorId,
            note: input.note ?? "",
            createdAt: "2026-10-02T00:00:00.000Z",
            overdue: false,
          },
          decision: input.decision,
          message: "已通过申诉",
        }),
      },
    }).app;
    const { token } = await tokens.issue({ userId: "mod", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    // 缺 CSRF：写方法一律 403（全局钩子）
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/punishments/ABC123/release",
      headers: { cookie },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);

    // 非法 action → 400
    const badAction = await app.inject({
      method: "POST",
      url: "/api/punishments/ABC123/explode",
      headers: { cookie, "x-admin-request": "1" },
      payload: {},
    });
    expect(badAction.statusCode).toBe(400);

    // 改禁言时长缺 seconds → 400
    const noSeconds = await app.inject({
      method: "POST",
      url: "/api/punishments/ABC123/mute",
      headers: { cookie, "x-admin-request": "1" },
      payload: {},
    });
    expect(noSeconds.statusCode).toBe(400);

    // 正常解除
    const released = await app.inject({
      method: "POST",
      url: "/api/punishments/ABC123/release",
      headers: { cookie, "x-admin-request": "1" },
      payload: { note: "申诉通过" },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ ok: true });

    // 黑名单：本群缺 group → 400；全局不需要 group
    const badBlacklist = await app.inject({
      method: "POST",
      url: "/api/blacklist",
      headers: { cookie, "x-admin-request": "1" },
      payload: { scope: "group", userId: "u1" },
    });
    expect(badBlacklist.statusCode).toBe(400);
    const globalBlacklist = await app.inject({
      method: "POST",
      url: "/api/blacklist",
      headers: { cookie, "x-admin-request": "1" },
      payload: { scope: "global", userId: "u1", reason: "屡犯" },
    });
    expect(globalBlacklist.statusCode).toBe(200);
    expect(globalBlacklist.json()).toMatchObject({
      result: { action: "add", kickedGroups: 1 },
    });

    // 解除：本群缺 ?group= → 400
    const badRemove = await app.inject({
      method: "DELETE",
      url: "/api/blacklist/u1?scope=group",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(badRemove.statusCode).toBe(400);

    // 申诉复核：decision 只能是 accept / reject
    const badDecision = await app.inject({
      method: "POST",
      url: "/api/appeals/ABCDEF/maybe",
      headers: { cookie, "x-admin-request": "1" },
      payload: {},
    });
    expect(badDecision.statusCode).toBe(400);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/appeals/ABCDEF/accept",
      headers: { cookie, "x-admin-request": "1" },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      result: { decision: "accepted" },
    });

    // 装配点收到的参数（actor 来自会话，不是请求体）
    expect(calls).toContainEqual({
      kind: "punish",
      code: "ABC123",
      action: "release",
      actorId: "mod",
      note: "申诉通过",
    });
    await app.close();

    // 只读巡检模式：写端点 503
    const bareTokens = memoryTokens();
    const bare = buildAdminApiServer({ config: CONFIG, tokens: bareTokens }).app;
    const bareToken = await bareTokens.issue({ userId: "mod", ttlMs: 60_000 });
    const bareLogin = await bare.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: bareToken.token },
    });
    const bareResponse = await bare.inject({
      method: "POST",
      url: "/api/punishments/ABC123/release",
      headers: { cookie: cookieOf(bareLogin), "x-admin-request": "1" },
      payload: {},
    });
    expect(bareResponse.statusCode).toBe(503);
    await bare.close();
  });

  it("通知门槛与测试推送：写端点要 CSRF，改门槛要整数，测试只发自己", async () => {
    const tokens = memoryTokens();
    const topics = [
      {
        topic: "join",
        label: "入群申请",
        hint: "有新的待处理入群申请时私信你",
        defaultLevel: 130,
        level: 130,
        allScope: 1,
        groupScopes: 0,
      },
    ];
    const calls: Array<Record<string, unknown>> = [];
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      writers: {
        setNotifyLevel: async (input) => {
          calls.push({ kind: "level", ...input });
          return { topics, message: "已改门槛" };
        },
        resetNotifyLevels: async (actorId) => {
          calls.push({ kind: "reset", actorId });
          return { topics, message: "已恢复默认" };
        },
        sendNotifyTest: async (input) => {
          calls.push({ kind: "test", ...input });
          return { ok: true, message: "已把测试卡私信发给你。" };
        },
      },
    }).app;
    const { token } = await tokens.issue({ userId: "mod", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    // 写方法缺 CSRF → 403
    const noCsrf = await app.inject({
      method: "PUT",
      url: "/api/notify/levels",
      headers: { cookie },
      payload: { topic: "join", level: 130 },
    });
    expect(noCsrf.statusCode).toBe(403);

    // 非整数门槛 → 400
    const badLevel = await app.inject({
      method: "PUT",
      url: "/api/notify/levels",
      headers: { cookie, "x-admin-request": "1" },
      payload: { topic: "join", level: "半开" },
    });
    expect(badLevel.statusCode).toBe(400);

    // 正常改：actor 来自会话
    const ok = await app.inject({
      method: "PUT",
      url: "/api/notify/levels",
      headers: { cookie, "x-admin-request": "1" },
      payload: { topic: "join", level: 140 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, message: "已改门槛" });

    // 测试推送：收件人取会话 userId，**不接受请求体指定别人**
    const test = await app.inject({
      method: "POST",
      url: "/api/notify/test",
      headers: { cookie, "x-admin-request": "1" },
      payload: { userId: "someone-else" },
    });
    expect(test.statusCode).toBe(200);
    expect(calls).toContainEqual({ kind: "test", userId: "mod" });
    expect(calls.some((call) => call["userId"] === "someone-else")).toBe(false);

    await app.close();
  });

  it("规则关键词 / 恢复继承 / 别名表：参数校验与门槛都在路由层挡住明显的错", async () => {
    const tokens = memoryTokens();
    const calls: Array<Record<string, unknown>> = [];
    const aliases = [{ alias: "环工2214", target: "环境类2214", kind: "class" }];
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      readers: {
        aliases: async () => aliases,
      },
      writers: {
        addRuleKeywords: async (input) => {
          calls.push({ kind: "kw-add", ...input });
          return {
            keywords: ["广告"],
            added: ["广告"],
            removed: [],
            skipped: [],
            message: "已添加 1 个关键词，当前共 1 条。",
          };
        },
        removeRuleKeywords: async (input) => {
          calls.push({ kind: "kw-remove", ...input });
          return {
            keywords: [],
            added: [],
            removed: ["广告"],
            skipped: [],
            message: "已删除 1 个关键词，当前共 0 条。",
          };
        },
        resetRuleFields: async (input) => {
          calls.push({ kind: "reset-fields", ...input });
          return {
            groupId: input.groupId,
            scope: "fields" as const,
            fields: input.fields,
            overriddenFields: [],
            message: "已恢复 1 个字段的继承。",
          };
        },
        resetRuleGroup: async (input) => {
          calls.push({ kind: "reset-all", ...input });
          return {
            groupId: input.groupId,
            scope: "all" as const,
            fields: [],
            overriddenFields: [],
            message: "本群全部覆盖已清空。",
          };
        },
        setAlias: async (input) => {
          calls.push({ kind: "alias-set", ...input });
          return { ok: true, message: "已保存别名。", aliases };
        },
        removeAlias: async (input) => {
          calls.push({ kind: "alias-remove", ...input });
          return { ok: true, message: "已删除别名。", aliases: [] };
        },
      },
    }).app;
    const { token } = await tokens.issue({ userId: "admin", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);
    const write = { cookie, "x-admin-request": "1" };

    // 关键词：缺 group / 缺 words 都 400；正常带 actor 进后端
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/rules/keywords",
          headers: write,
          payload: { action: "add", words: ["广告"] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/rules/keywords",
          headers: write,
          payload: { group: "g1", action: "add", words: [] },
        })
      ).statusCode,
    ).toBe(400);
    const added = await app.inject({
      method: "POST",
      url: "/api/rules/keywords",
      headers: write,
      payload: { group: "g1", action: "add", words: ["广告"] },
    });
    expect(added.statusCode).toBe(200);
    expect(calls).toContainEqual({
      kind: "kw-add",
      groupId: "g1",
      words: ["广告"],
      actorId: "admin",
    });

    // 恢复继承：缺 fields 400；整群重置可以不带 fields
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/rules/reset-fields",
          headers: write,
          payload: { group: "g1" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/rules/reset",
          headers: write,
          payload: { group: "g1" },
        })
      ).statusCode,
    ).toBe(200);

    // 别名：读要装配；写要 alias + target
    const list = await app.inject({ method: "GET", url: "/api/aliases", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ aliases });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/aliases",
          headers: write,
          payload: { alias: "环工2214" },
        })
      ).statusCode,
    ).toBe(400);
    const removedAlias = await app.inject({
      method: "DELETE",
      url: "/api/aliases/%E7%8E%AF%E5%B7%A52214",
      headers: write,
    });
    expect(removedAlias.statusCode).toBe(200);
    expect(calls).toContainEqual({
      kind: "alias-remove",
      alias: "环工2214",
      actorId: "admin",
    });

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
            group: groupRef(index % 2 === 0 ? "g1" : "g2"),
            actor: userRef(index === 0 ? "op1" : "op2"),
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
            group: groupRef(index < 3 ? "g1" : "g2"),
            applicant: userRef(`u${index}`),
            request: requestRef(`r${index}`),
          })),
        rules: async (groupId: string) => ({
          groupId,
          group: groupRef(groupId),
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

  it("活动字段目录（登录即可）+ 改字段 PUT（要 CSRF、参数校验、只读巡检 503）", async () => {
    const tokens = memoryTokens();
    const calls: Array<{
      code: string;
      field: string;
      value: string;
      actorId: string;
    }> = [];
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      writers: {
        updateActivity: async (input) => {
          calls.push(input);
          return {
            activity: {
              activityId: "a1",
              code: input.code,
              title: "春游",
              groupId: "g1",
              status: "open",
              registered: 0,
              createdAt: "2026-10-01T00:00:00.000Z",
              group: groupRef("g1"),
              boundGroups: [groupRef("g1")],
            },
            field: input.field,
            fieldLabel: "名额",
            before: "不限",
            after: input.value,
            message: "**结果**：已更新 capacity。",
          };
        },
      },
    }).app;

    const unauth = await app.inject({
      method: "GET",
      url: "/api/activities/fields",
    });
    expect(unauth.statusCode).toBe(401);

    const { token } = await tokens.issue({ userId: "admin", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    // 字段目录来自指令层同一份 `ACTIVITY_SETTING_FIELDS`
    const fields = await app.inject({
      method: "GET",
      url: "/api/activities/fields",
      headers: { cookie },
    });
    expect(fields.statusCode).toBe(200);
    const catalog = fields.json<{
      fields: Array<{ field: string; label: string; kind: string }>;
    }>().fields;
    expect(catalog.map((field) => field.field)).toContain("capacity");
    expect(catalog.find((field) => field.field === "capacity")?.label).toBe(
      "名额",
    );
    expect(catalog.find((field) => field.field === "递补")).toBeUndefined();

    // 写操作缺 CSRF 头 → 403
    const noCsrf = await app.inject({
      method: "PUT",
      url: "/api/activities/ACT001",
      headers: { cookie },
      payload: { field: "capacity", value: "10" },
    });
    expect(noCsrf.statusCode).toBe(403);

    const noField = await app.inject({
      method: "PUT",
      url: "/api/activities/ACT001",
      headers: { cookie, "x-admin-request": "1" },
      payload: { value: "10" },
    });
    expect(noField.statusCode).toBe(400);

    const badValue = await app.inject({
      method: "PUT",
      url: "/api/activities/ACT001",
      headers: { cookie, "x-admin-request": "1" },
      payload: { field: "capacity", value: 10 },
    });
    expect(badValue.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PUT",
      url: "/api/activities/ACT001",
      headers: { cookie, "x-admin-request": "1" },
      payload: { field: "capacity", value: "10" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      ok: true,
      field: "capacity",
      fieldLabel: "名额",
      before: "不限",
      after: "10",
    });
    expect(calls).toEqual([
      { code: "ACT001", field: "capacity", value: "10", actorId: "admin" },
    ]);
    await app.close();

    // 只读巡检模式（不装配 writers）→ 503
    const bareTokens = memoryTokens();
    const bare = buildAdminApiServer({
      config: CONFIG,
      tokens: bareTokens,
      version: "test",
    }).app;
    const bareToken = await bareTokens.issue({ userId: "admin", ttlMs: 60_000 });
    const bareLogin = await bare.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: bareToken.token },
    });
    const bareResponse = await bare.inject({
      method: "PUT",
      url: "/api/activities/ACT001",
      headers: { cookie: cookieOf(bareLogin), "x-admin-request": "1" },
      payload: { field: "capacity", value: "10" },
    });
    expect(bareResponse.statusCode).toBe(503);
    await bare.close();
  });

  it("统计报表：平台超管可看全量，其他人必须带 group 且本群 130；只读巡检 503", async () => {
    const tokens = memoryTokens();
    const calls: Array<{ group?: string; days: number }> = [];
    const REPORTS_VIEW = {
      range: {
        days: 7,
        from: "2026-09-26T00:00:00.000Z",
        to: "2026-10-02T12:00:00.000Z",
      },
      groups: [],
      daily: [],
      totals: {
        events: 0,
        approvals: 0,
        rejections: 0,
        expired: 0,
        punishments: 0,
        registrations: 0,
        waitlist: 0,
        deliveries: 0,
        deliveryFailed: 0,
        newActivities: 0,
        openActivities: 0,
      },
      activities: [],
    };
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      readAccessOf: async (userId: string) =>
        userId === "boss"
          ? { platformLevel: 240, groups: [] }
          : { platformLevel: 0, groups: [{ groupId: "g1", level: userId === "mod" ? 120 : 130 }] },
      readers: {
        pending: async () => [],
        rules: async (groupId: string) => ({ groupId, override: null, settings: [] }),
        notifyTopics: async () => [],
        activities: async () => [],
        reports: async (options) => {
          calls.push(options);
          return REPORTS_VIEW;
        },
      },
    }).app;

    const login = async (userId: string): Promise<string> => {
      const { token } = await tokens.issue({ userId, ttlMs: 60_000 });
      const response = await app.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "x-admin-request": "1" },
        payload: { token },
      });
      return cookieOf(response);
    };

    // 平台超管：不传 group = 全量，days 会被夹到 1–90
    const boss = await login("boss");
    const all = await app.inject({
      method: "GET",
      url: "/api/reports?days=30",
      headers: { cookie: boss },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ range: { days: 7 } });
    expect(calls).toEqual([{ days: 30 }]);

    // 非超管：缺 group 直接 400（与 /api/audit 同口径）
    const admin = await login("admin");
    const missingGroup = await app.inject({
      method: "GET",
      url: "/api/reports",
      headers: { cookie: admin },
    });
    expect(missingGroup.statusCode).toBe(400);

    const byGroup = await app.inject({
      method: "GET",
      url: "/api/reports?group=g1&days=365",
      headers: { cookie: admin },
    });
    expect(byGroup.statusCode).toBe(200);
    // 年这种越界值被夹到上限，不会把聚合拖死
    expect(calls[1]).toEqual({ group: "g1", days: 90 });

    // 本群审核员 120：看得了审计，但看不了报表（报表要 130）
    const mod = await login("mod");
    const denied = await app.inject({
      method: "GET",
      url: "/api/reports?group=g1",
      headers: { cookie: mod },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();

    // 只读巡检模式没有内存态 → 503
    const bareTokens = memoryTokens();
    const bare = buildAdminApiServer({
      config: CONFIG,
      tokens: bareTokens,
      version: "test",
    }).app;
    const bareToken = await bareTokens.issue({ userId: "boss", ttlMs: 60_000 });
    const bareLogin = await bare.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: bareToken.token },
    });
    const bareResponse = await bare.inject({
      method: "GET",
      url: "/api/reports",
      headers: { cookie: cookieOf(bareLogin) },
    });
    expect(bareResponse.statusCode).toBe(503);
    await bare.close();
  });

  it("报表 CSV：带 BOM 下载、参数透传；只读巡检 503", async () => {
    const tokens = memoryTokens();
    const calls: Array<{ actorId: string; group?: string; days: number; full: boolean }> = [];
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      writers: {
        exportReportsCsv: async (actorId, options) => {
          calls.push({
            actorId,
            ...(options.group !== undefined ? { group: options.group } : {}),
            days: options.days,
            full: options.full,
          });
          return {
            filename: "report-g1-30d.csv",
            csv: "section,metric,bucket,group,value\ntotal,events,,群g1,3\n",
            rows: 1,
            full: options.full,
          };
        },
      },
    }).app;
    const { token } = await tokens.issue({ userId: "admin", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = cookieOf(login);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/export.csv?group=g1&days=30",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("report-g1-30d.csv");
    expect(response.body.startsWith("\uFEFF")).toBe(true);
    expect(calls).toEqual([
      { actorId: "admin", group: "g1", days: 30, full: false },
    ]);
    await app.close();

    const bareTokens = memoryTokens();
    const bare = buildAdminApiServer({
      config: CONFIG,
      tokens: bareTokens,
      version: "test",
    }).app;
    const bareToken = await bareTokens.issue({ userId: "admin", ttlMs: 60_000 });
    const bareLogin = await bare.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token: bareToken.token },
    });
    const bareResponse = await bare.inject({
      method: "GET",
      url: "/api/reports/export.csv?group=g1",
      headers: { cookie: cookieOf(bareLogin) },
    });
    expect(bareResponse.statusCode).toBe(503);
    await bare.close();
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

  it("机器令牌细粒度 scope：read:join 只能读待审批，write:activity 只能改活动", async () => {
    const tokens = memoryTokens();
    const config = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: "m".repeat(40),
      ADMIN_API_TOKENS: [
        "pending-only-token-12:read:join",
        "activity-writer-token-12:write:activity",
      ].join(","),
    });
    const calls: string[] = [];
    const app = buildAdminApiServer({
      config,
      tokens,
      version: "test",
      readers: {
        pending: async () => [],
        rules: async (groupId: string) => ({ groupId, override: null, settings: [] }),
        notifyTopics: async () => [],
        activities: async () => [],
      },
      writers: {
        exportAuditCsv: async () => ({
          filename: "audit-all.csv",
          csv: "record_id\n",
          rows: 0,
          full: false,
        }),
        createActivity: async (input) => {
          calls.push(`create:${input.groupId}`);
          return {
            activity: {
              activityId: "a1",
              code: "ACT001",
              title: input.title,
              groupId: input.groupId,
              status: "draft",
              registered: 0,
              createdAt: "2026-10-01T00:00:00.000Z",
              group: groupRef(input.groupId),
              boundGroups: [groupRef(input.groupId)],
            },
            boundGroups: [groupRef(input.groupId)],
            message: "已新建活动草稿。",
          };
        },
      },
    }).app;

    const pendingToken = { authorization: "Bearer pending-only-token-12" };
    const activityToken = { authorization: "Bearer activity-writer-token-12" };

    // read:join 能读待审批
    const pending = await app.inject({
      method: "GET",
      url: "/api/pending",
      headers: pendingToken,
    });
    expect(pending.statusCode).toBe(200);

    // 同一把令牌读审计 → 403（错误里点名它缺 read:audit）
    const auditDenied = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: pendingToken,
    });
    expect(auditDenied.statusCode).toBe(403);
    expect(auditDenied.json<{ message: string }>().message).toContain("read:audit");

    // read:join 不能写（它没有 write:join）
    const writeDenied = await app.inject({
      method: "POST",
      url: "/api/join/sync",
      headers: pendingToken,
      payload: { group: "g1" },
    });
    expect(writeDenied.statusCode).toBe(403);

    // write:activity 能建活动（机器令牌不需要 CSRF 头）
    const created = await app.inject({
      method: "POST",
      url: "/api/activities",
      headers: activityToken,
      payload: { group: "g1", title: "春游" },
    });
    expect(created.statusCode).toBe(200);
    expect(calls).toEqual(["create:g1"]);

    // 但它改不了处罚（write:punish 没给）
    const punishDenied = await app.inject({
      method: "POST",
      url: "/api/punishments/PUN001/release",
      headers: activityToken,
      payload: {},
    });
    expect(punishDenied.statusCode).toBe(403);
    expect(punishDenied.json<{ message: string }>().message).toContain("write:punish");

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
