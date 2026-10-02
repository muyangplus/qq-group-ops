import { describe, expect, it } from "vitest";

import { loadAdminApiConfig } from "../src/adminApi/config.js";
import {
  buildAdminApiServer,
  type AdminApiDeniedInput,
  type AdminApiReadAccess,
} from "../src/adminApi/server.js";
import type { AdminTokenRepository } from "../src/db/adminTokenRepository.js";

/**
 * 只读端点的逐路由门槛（E1-g）。
 *
 * 口径（见 docs/ADMIN-API.md 的 E1-g）：平台级信息（状态 / 话题门槛 / 全局规则）要平台超管 240；
 * 群级数据按本群档位**裁剪或拒绝**（审计 120 起 / 待审批 120 / 规则查看 120）；
 * 机器令牌（运维自己配的服务凭据）视为平台级只读；未装配 `readAccessOf` 时全量放行（兼容旧行为）。
 */

/** 各账号的只读范围：`boss` 平台超管，`mod1` 是 g1 的审核员，`other` 是 g2 的本群超管。 */
const ACCESS: Record<string, AdminApiReadAccess> = {
  boss: { platformLevel: 240, groups: [] },
  mod1: { platformLevel: 0, groups: [{ groupId: "g1", level: 120 }] },
  other: { platformLevel: 0, groups: [{ groupId: "g2", level: 140 }] },
};

function memoryTokens(): AdminTokenRepository {
  const rows = new Map<string, string>();
  let serial = 0;
  return {
    async issue({ userId }) {
      serial += 1;
      const token = `tok-${serial}`;
      rows.set(token, userId);
      return { token, expiresAt: new Date(Date.now() + 60_000) };
    },
    async redeem(token) {
      const userId = rows.get(token.trim());
      if (userId === undefined) {
        return undefined;
      }
      rows.delete(token.trim());
      return userId;
    },
    async pruneExpired() {
      // 内存版无需清理
    },
    async countActive() {
      return rows.size;
    },
  };
}

function build(options: { gated?: boolean; machineTokens?: string } = {}) {
  const tokens = memoryTokens();
  const denied: AdminApiDeniedInput[] = [];
  const config = loadAdminApiConfig({
    ADMIN_API_ENABLED: "true",
    ADMIN_API_SESSION_SECRET: "y".repeat(40),
    ...(options.machineTokens !== undefined
      ? { ADMIN_API_TOKENS: options.machineTokens }
      : {}),
  });
  const server = buildAdminApiServer({
    config,
    tokens,
    version: "test",
    readers: {
      pending: async () => [
        { requestId: "r1", groupId: "g1", userId: "u1", reason: "", createdAt: "" },
        { requestId: "r2", groupId: "g2", userId: "u2", reason: "", createdAt: "" },
      ],
      rules: async (groupId: string) => ({
        groupId,
        override: null,
        settings: [],
      }),
      notifyTopics: async () => [],
      activities: async () => [
        {
          activityId: "a1",
          code: "A1",
          title: "g1 的活动",
          groupId: "g1",
          status: "open",
          registered: 0,
          createdAt: "",
        },
        {
          activityId: "a2",
          code: "A2",
          title: "g2 的活动",
          groupId: "g2",
          status: "open",
          registered: 0,
          createdAt: "",
        },
      ],
    },
    auditReader: {
      list: async () => [
        {
          recordId: "x1",
          groupId: "g1",
          actorId: "u1",
          action: "a",
          status: "executed",
          reason: "",
          createdAt: "",
        },
        {
          recordId: "x2",
          groupId: "g2",
          actorId: "u2",
          action: "a",
          status: "executed",
          reason: "",
          createdAt: "",
        },
      ],
    },
    ...(options.gated === false
      ? {}
      : {
          readAccessOf: async (userId: string) =>
            ACCESS[userId] ?? { platformLevel: 0, groups: [] },
          auditDenied: (input: AdminApiDeniedInput) => {
            denied.push(input);
          },
        }),
  });
  return { app: server.app, tokens, denied };
}

/** 用一次性令牌换一个会话 cookie。 */
async function login(
  app: ReturnType<typeof buildAdminApiServer>["app"],
  tokens: AdminTokenRepository,
  userId: string,
): Promise<string> {
  const { token } = await tokens.issue({ userId, ttlMs: 60_000 });
  const login = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: { "x-admin-request": "1" },
    payload: { token },
  });
  const raw = login.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return header.split(";")[0] ?? "";
}

describe("只读端点门槛（E1-g）", () => {
  it("平台级端点：非 240 403 且写审计，240 放行", async () => {
    const { app, tokens, denied } = build();
    const modCookie = await login(app, tokens, "mod1");
    const bossCookie = await login(app, tokens, "boss");

    for (const url of ["/api/status", "/api/notify/topics"]) {
      const deniedRes = await app.inject({
        method: "GET",
        url,
        headers: { cookie: modCookie },
      });
      expect(deniedRes.statusCode).toBe(403);
      expect(deniedRes.json()).toMatchObject({ error: "forbidden" });

      const okRes = await app.inject({
        method: "GET",
        url,
        headers: { cookie: bossCookie },
      });
      expect(okRes.statusCode).toBe(200);
    }

    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({
      actorId: "mod1",
      route: "GET /api/status",
      reason: "需要平台超级管理员（240）",
    });
    await app.close();
  });

  it("审计：非 240 必须带 ?group=，且按该群档位判定（120 起）", async () => {
    const { app, tokens, denied } = build();
    const modCookie = await login(app, tokens, "mod1");

    const noGroup = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: modCookie },
    });
    expect(noGroup.statusCode).toBe(400);
    expect(noGroup.json()).toMatchObject({ error: "bad_request" });

    // mod1 只够 g1（120）
    const g1 = await app.inject({
      method: "GET",
      url: "/api/audit?group=g1",
      headers: { cookie: modCookie },
    });
    expect(g1.statusCode).toBe(200);
    expect(g1.json<{ items: Array<{ groupId: string }> }>().items).toEqual([
      expect.objectContaining({ groupId: "g1" }),
    ]);

    const g2 = await app.inject({
      method: "GET",
      url: "/api/audit?group=g2",
      headers: { cookie: modCookie },
    });
    expect(g2.statusCode).toBe(403);
    expect(denied.at(-1)).toMatchObject({
      route: "GET /api/audit",
      groupId: "g2",
      reason: "需要本群档位 120",
    });
    await app.close();
  });

  it("待审批与活动列表：按群裁剪而不是报错", async () => {
    const { app, tokens } = build();
    const modCookie = await login(app, tokens, "mod1");

    const pending = await app.inject({
      method: "GET",
      url: "/api/pending",
      headers: { cookie: modCookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(
      pending.json<{ items: Array<{ requestId: string }> }>().items.map((item) => item.requestId),
    ).toEqual(["r1"]);

    const activities = await app.inject({
      method: "GET",
      url: "/api/activities",
      headers: { cookie: modCookie },
    });
    expect(
      activities.json<{ items: Array<{ activityId: string }> }>().items.map((item) => item.activityId),
    ).toEqual(["a1"]);

    // 280 情况：平台超管拿到全部
    const bossCookie = await login(app, tokens, "boss");
    const all = await app.inject({
      method: "GET",
      url: "/api/pending",
      headers: { cookie: bossCookie },
    });
    expect(all.json<{ total: number }>().total).toBe(2);
    await app.close();
  });

  it("规则：单群要 120，全局（__default__）要平台超管", async () => {
    const { app, tokens } = build();
    const modCookie = await login(app, tokens, "mod1");
    const bossCookie = await login(app, tokens, "boss");

    const own = await app.inject({
      method: "GET",
      url: "/api/rules?group=g1",
      headers: { cookie: modCookie },
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: "GET",
      url: "/api/rules?group=g2",
      headers: { cookie: modCookie },
    });
    expect(other.statusCode).toBe(403);

    const globalAsMod = await app.inject({
      method: "GET",
      url: "/api/rules?group=__default__",
      headers: { cookie: modCookie },
    });
    expect(globalAsMod.statusCode).toBe(403);

    const globalAsBoss = await app.inject({
      method: "GET",
      url: "/api/rules?group=__default__",
      headers: { cookie: bossCookie },
    });
    expect(globalAsBoss.statusCode).toBe(200);
    await app.close();
  });

  it("机器令牌视为平台级只读（运维自己配的凭据），不受逐路由门槛限制", async () => {
    const machine = "machine-read-token-alpha";
    const { app } = build({ machineTokens: `${machine}:read` });

    const status = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${machine}` },
    });
    expect(status.statusCode).toBe(200);

    const pending = await app.inject({
      method: "GET",
      url: "/api/pending",
      headers: { authorization: `Bearer ${machine}` },
    });
    expect(pending.json<{ total: number }>().total).toBe(2);
    await app.close();
  });

  it("未装配 readAccessOf（只读巡检 / 单测）时全量放行", async () => {
    const { app, tokens } = build({ gated: false });
    const cookie = await login(app, tokens, "mod1");

    const status = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json<{ total: number }>().total).toBe(2);
    await app.close();
  });
});
