import { describe, expect, it } from "vitest";

import { loadAdminApiConfig } from "../src/adminApi/config.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import {
  buildAdminApiServer,
  type AdminApiWriters,
} from "../src/adminApi/server.js";
import type { AdminTokenRepository } from "../src/db/adminTokenRepository.js";

/**
 * 管理 API 的写端点（E1-d，HTTP 层）。
 *
 * HTTP 层只做「取参数 → 调 writer → 序列化」：这里用**桩 writers** 断言路由形状、
 * 校验与状态码映射（真实领域逻辑由 test/adminApiBackend.test.ts 覆盖）。
 */

const CONFIG = loadAdminApiConfig({
  ADMIN_API_ENABLED: "true",
  ADMIN_API_SESSION_SECRET: "y".repeat(40),
  ADMIN_API_PUBLIC_BASE_URL: "https://ops.example.com",
});

/** 内存版一次性令牌仓储（SQL 版由 test/adminTokenRepository.test.ts 覆盖）。 */
function memoryTokens(): AdminTokenRepository {
  const rows = new Map<
    string,
    { userId: string; expiresAt: number; used: boolean }
  >();
  return {
    async issue({ userId }) {
      const token = `tok-${rows.size + 1}`;
      const expiresAt = new Date(Date.now() + 60_000);
      rows.set(token, { userId, expiresAt: expiresAt.getTime(), used: false });
      return { token, expiresAt };
    },
    async redeem(token) {
      const row = rows.get(token.trim());
      if (!row || row.used || row.expiresAt <= Date.now()) {
        return undefined;
      }
      row.used = true;
      return row.userId;
    },
    async pruneExpired() {
      // 内存版无需清理
    },
    async countActive() {
      return [...rows.values()].filter(
        (row) => !row.used && row.expiresAt > Date.now(),
      ).length;
    },
  };
}

/** 记录调用的桩 writers：默认全部成功，单个方法可以用 `overrides` 换掉。 */
function stubWriters(
  overrides: Partial<AdminApiWriters> = {},
): AdminApiWriters & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return result;
    };
  return {
    calls,
    approveJoin:
      overrides.approveJoin ??
      record("approveJoin", {
        requestId: "r1",
        groupId: "g1",
        status: "approved",
        message: "已通过入群申请。",
      }),
    rejectJoin:
      overrides.rejectJoin ??
      record("rejectJoin", {
        requestId: "r1",
        groupId: "g1",
        status: "rejected",
        message: "已拒绝入群申请。",
      }),
    updateRule:
      overrides.updateRule ??
      record("updateRule", {
        groupId: "g1",
        locale: "group" as const,
        fields: ["warningMessage"],
        message: "已更新群规则。",
      }),
    setActivityStatus:
      overrides.setActivityStatus ??
      record("setActivityStatus", {
        activityId: "a1",
        code: "A1",
        groupId: "g1",
        status: "open",
        message: "活动状态已更新为 open。",
      }),
    exportActivityCsv:
      overrides.exportActivityCsv ??
      record("exportActivityCsv", {
        filename: "activity-A1.csv",
        csv: "序号,姓名,学号,班级,学院,备注,候补\n1,小明,,,,\n",
        rows: 1,
        full: false,
      }),
    retryModule:
      overrides.retryModule ??
      record("retryModule", {
        module: { key: "config", label: "群规则", state: "ready" },
        recovered: true,
        message: "「群规则」已重新加载成功，功能立即恢复，不用重启进程。",
      }),
  };
}

async function loggedIn(
  writers: AdminApiWriters | undefined,
): Promise<{ app: ReturnType<typeof buildAdminApiServer>["app"]; cookie: string }> {
  const tokens = memoryTokens();
  const server = buildAdminApiServer({
    config: CONFIG,
    tokens,
    version: "test",
    ...(writers !== undefined ? { writers } : {}),
  });
  const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
  const login = await server.app.inject({
    method: "POST",
    url: "/auth/token",
    headers: { "x-admin-request": "1" },
    payload: { token },
  });
  const raw = login.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return { app: server.app, cookie: header.split(";")[0] ?? "" };
}

describe("管理 API 写端点（HTTP 层）", () => {
  it("没有 writers（只读巡检模式）时写端点回 503", async () => {
    const { app, cookie } = await loggedIn(undefined);

    const approve = await app.inject({
      method: "POST",
      url: "/api/pending/r1/approve",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(approve.statusCode).toBe(503);
    expect(approve.json()).toMatchObject({ error: "unavailable" });

    const rules = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers: { cookie, "x-admin-request": "1" },
      payload: { group: "g1", field: "warning", value: "x" },
    });
    expect(rules.statusCode).toBe(503);

    const activity = await app.inject({
      method: "POST",
      url: "/api/activities/A1/open",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(activity.statusCode).toBe(503);

    const csv = await app.inject({
      method: "GET",
      url: "/api/activities/A1/export.csv",
      headers: { cookie },
    });
    expect(csv.statusCode).toBe(503);

    // 运维写（降级模块重试）在只读巡检模式下也一样：没有健康注册表 → 503
    const retry = await app.inject({
      method: "POST",
      url: "/api/health/modules/config/retry",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(retry.statusCode).toBe(503);
    expect(retry.json()).toMatchObject({ error: "unavailable" });
    await app.close();
  });

  it("降级模块重试（运维写）：key 与登录账号原样进 writer，仍失败回 ok=false", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);

    const recovered = await app.inject({
      method: "POST",
      url: "/api/health/modules/config/retry",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      ok: true,
      result: { recovered: true, module: { key: "config", state: "ready" } },
    });
    expect(writers.calls[0]).toEqual({
      method: "retryModule",
      args: ["config", "op1"],
    });

    // 仍然起不来：HTTP 仍是 200，「没恢复」靠 ok=false + 原话原因表达
    const still = stubWriters({
      retryModule: async () => ({
        module: { key: "config", label: "群规则", state: "degraded", error: "bad row" },
        recovered: false,
        message: "「群规则」仍然起不来：bad row。修好数据 / 环境后可再试一次。",
      }),
    });
    const second = await loggedIn(still);
    const response = await second.app.inject({
      method: "POST",
      url: "/api/health/modules/config/retry",
      headers: { cookie: second.cookie, "x-admin-request": "1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      result: { recovered: false, module: { error: "bad row" } },
    });
    expect(response.json().result.message).toContain("bad row");

    // 缺 CSRF：写方法一律 403（全局钩子，不区分哪个端点）
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/health/modules/config/retry",
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);

    await app.close();
    await second.app.close();
  });

  it("通过 / 拒绝：actor 是登录账号，参数原样进 writer", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);

    const approve = await app.inject({
      method: "POST",
      url: "/api/pending/r1/approve",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({
      ok: true,
      requestId: "r1",
      status: "approved",
    });
    expect(writers.calls[0]).toEqual({
      method: "approveJoin",
      args: ["r1", "op1"],
    });

    const reject = await app.inject({
      method: "POST",
      url: "/api/pending/%23M7K2Q9/reject",
      headers: { cookie, "x-admin-request": "1" },
      payload: { reason: "资料不完整" },
    });
    expect(reject.statusCode).toBe(200);
    expect(writers.calls[1]).toEqual({
      method: "rejectJoin",
      args: ["#M7K2Q9", "op1", "资料不完整"],
    });

    // 不带 reason 时给空串（不是 undefined）
    await app.inject({
      method: "POST",
      url: "/api/pending/r2/reject",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(writers.calls[2]).toEqual({
      method: "rejectJoin",
      args: ["r2", "op1", ""],
    });
    await app.close();
  });

  it("写规则：PUT 的 body 校验（缺 group / field、value 非字符串都 400）", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);
    const headers = { cookie, "x-admin-request": "1" };

    const missingGroup = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers,
      payload: { field: "warning", value: "x" },
    });
    expect(missingGroup.statusCode).toBe(400);
    expect(missingGroup.json()).toMatchObject({ error: "bad_request" });

    const missingField = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers,
      payload: { group: "g1", value: "x" },
    });
    expect(missingField.statusCode).toBe(400);

    const badValue = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers,
      payload: { group: "g1", field: "warning", value: 3 },
    });
    expect(badValue.statusCode).toBe(400);

    expect(writers.calls).toHaveLength(0);

    const ok = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers,
      payload: { group: "g1", field: "warning", value: "本群新文案" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, fields: ["warningMessage"] });
    expect(writers.calls[0]).toEqual({
      method: "updateRule",
      args: ["g1", "warning", "本群新文案", "op1"],
    });
    await app.close();
  });

  it("活动动作只认 open / close / cancel，别的回 400", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);

    const bad = await app.inject({
      method: "POST",
      url: "/api/activities/A1/delete",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(bad.statusCode).toBe(400);
    expect(writers.calls).toHaveLength(0);

    const ok = await app.inject({
      method: "POST",
      url: "/api/activities/A1/open",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(writers.calls[0]).toEqual({
      method: "setActivityStatus",
      args: ["A1", "open", "op1"],
    });
    await app.close();
  });

  it("名单 CSV：attachment + BOM，?full=1 透传给 writer", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);

    const masked = await app.inject({
      method: "GET",
      url: "/api/activities/A1/export.csv",
      headers: { cookie },
    });
    expect(masked.statusCode).toBe(200);
    expect(masked.headers["content-type"]).toContain("text/csv");
    expect(masked.headers["content-disposition"]).toBe(
      'attachment; filename="activity-A1.csv"',
    );
    expect(masked.body.startsWith("\uFEFF")).toBe(true);
    expect(writers.calls[0]).toEqual({
      method: "exportActivityCsv",
      args: ["A1", "op1", { full: false }],
    });

    await app.inject({
      method: "GET",
      url: "/api/activities/A1/export.csv?full=1",
      headers: { cookie },
    });
    expect(writers.calls[1]).toEqual({
      method: "exportActivityCsv",
      args: ["A1", "op1", { full: true }],
    });
    await app.close();
  });

  it("领域层错误按原状态码返回（403 / 404 / 409）", async () => {
    const writers = stubWriters({
      async approveJoin() {
        throw new AdminApiRequestError(403, "forbidden", "权限不足。");
      },
      async rejectJoin() {
        throw new AdminApiRequestError(409, "conflict", "已经被处理过了。");
      },
      async setActivityStatus() {
        throw new AdminApiRequestError(404, "not_found", "活动不存在。");
      },
    });
    const { app, cookie } = await loggedIn(writers);
    const headers = { cookie, "x-admin-request": "1" };

    const approve = await app.inject({
      method: "POST",
      url: "/api/pending/r1/approve",
      headers,
    });
    expect(approve.statusCode).toBe(403);
    expect(approve.json()).toEqual({
      error: "forbidden",
      message: "权限不足。",
    });

    const reject = await app.inject({
      method: "POST",
      url: "/api/pending/r1/reject",
      headers,
    });
    expect(reject.statusCode).toBe(409);

    const activity = await app.inject({
      method: "POST",
      url: "/api/activities/A1/open",
      headers,
    });
    expect(activity.statusCode).toBe(404);
    await app.close();
  });

  it("不支持的 Content-Type / 坏 JSON 按 4xx 回，不吞成 500", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);

    const badType = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers: { cookie, "x-admin-request": "1", "content-type": "application/xml" },
      payload: "<rules/>",
    });
    expect(badType.statusCode).toBe(415);
    expect(badType.json()).toMatchObject({ error: "bad_request" });

    const badJson = await app.inject({
      method: "PUT",
      url: "/api/rules",
      headers: { cookie, "x-admin-request": "1", "content-type": "application/json" },
      payload: "{不是 JSON",
    });
    expect(badJson.statusCode).toBeGreaterThanOrEqual(400);
    expect(badJson.statusCode).toBeLessThan(500);
    expect(writers.calls).toHaveLength(0);
    await app.close();
  });

  it("写端点同样要 CSRF 头、要登录", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/pending/r1/approve",
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: "csrf" });

    const anon = await app.inject({
      method: "POST",
      url: "/api/pending/r1/approve",
      headers: { "x-admin-request": "1" },
    });
    expect(anon.statusCode).toBe(401);
    expect(writers.calls).toHaveLength(0);
    await app.close();
  });

  it("机器令牌带 write scope 也能写，actor 是 machine:<前缀>（不暴露完整令牌）", async () => {
    const writers = stubWriters();
    const machine = "machine-write-token-alpha";
    const config = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: "y".repeat(40),
      ADMIN_API_TOKENS: `${machine}:write`,
    });
    const tokens = memoryTokens();
    const app = buildAdminApiServer({
      config,
      tokens,
      version: "test",
      writers,
    }).app;

    const ok = await app.inject({
      method: "POST",
      url: "/api/activities/A1/open",
      headers: { authorization: `Bearer ${machine}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(writers.calls[0]?.args[2]).toBe(
      `machine:${machine.slice(0, 8)}`,
    );
    await app.close();
  });
});
