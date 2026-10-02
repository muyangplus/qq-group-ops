import { describe, expect, it } from "vitest";

import { loadAdminApiConfig } from "../src/adminApi/config.js";
import { startAdminApiHost } from "../src/adminApi/host.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminTokenRepository } from "../src/db/adminTokenRepository.js";

/**
 * 同进程回环监听口（E1-d）。
 *
 * 这里真的**起一个监听口**（`ADMIN_API_PORT=0` 让内核分配端口），验证：
 * 端口是真绑上了、`url` 指向真实端口、`/healthz` 从真实 socket 能通、`close()` 能关。
 * 读写端点的行为由 `test/adminApiWriteEndpoints.test.ts` 用 `inject` 覆盖（不占端口）。
 */

const BASE = {
  ADMIN_API_ENABLED: "true",
  ADMIN_API_SESSION_SECRET: "y".repeat(40),
};

function memoryTokens(): AdminTokenRepository {
  const rows = new Set<string>();
  return {
    async issue({ userId }) {
      const token = `tok-${rows.size + 1}`;
      rows.add(token);
      return { token, expiresAt: new Date(Date.now() + 60_000) };
    },
    async redeem(token) {
      return rows.has(token) ? "op1" : undefined;
    },
    async pruneExpired() {
      // 内存版无需清理
    },
    async countActive() {
      return rows.size;
    },
  };
}

/** 只读 + 写都回固定值的桩后端：本文件只关心监听口本身。 */
const backend: AdminApiBackend = {
  status: async () => ({ database: "memory", migrationIssues: 0 }),
  audit: async () => [],
  pending: async () => [],
  rules: async (groupId) => ({ groupId, override: null, settings: [] }),
  notifyTopics: async () => [],
  activities: async () => [],
  permissionsOf: async () => ({ platformLevel: 240, groups: [] }),
  auditDenied: () => {
    // 本文件不关心审计
  },
  approveJoin: async (requestId) => ({
    requestId,
    groupId: "g1",
    status: "approved",
    message: "ok",
  }),
  rejectJoin: async (requestId) => ({
    requestId,
    groupId: "g1",
    status: "rejected",
    message: "ok",
  }),
  updateRule: async (groupId) => ({
    groupId,
    locale: "group",
    fields: [],
    message: "ok",
  }),
  setActivityStatus: async (code) => ({
    activityId: "a1",
    code,
    groupId: "g1",
    status: "open",
    message: "ok",
  }),
  exportActivityCsv: async () => ({
    filename: "activity-A1.csv",
    csv: "序号,姓名\n1,小明\n",
    rows: 1,
    full: false,
  }),
};

describe("startAdminApiHost", () => {
  it("绑一个真实回环端口：/healthz 能通，url 用真实端口，close 之后端口释放", async () => {
    const host = await startAdminApiHost({
      config: loadAdminApiConfig({ ...BASE, ADMIN_API_PORT: "0" }),
      tokens: memoryTokens(),
      backend,
      version: "test",
    });

    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(host.url.endsWith(":0")).toBe(false);

    const health = await fetch(`${host.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "test" });

    // 没登录的只读端点：401（鉴权钩子确实挂上了）
    const status = await fetch(`${host.url}/api/status`);
    expect(status.status).toBe(401);

    await host.close();
    // 关掉之后同一个地址不再有服务
    await expect(fetch(`${host.url}/healthz`)).rejects.toThrow();
  });
});
