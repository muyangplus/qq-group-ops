import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import type { IdentityBinding } from "../src/db/identityBindingRepository.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AuditLogStore } from "../src/services/audit.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";

/**
 * P3：**身份映射只读**（`GET /api/identities`）。
 *
 * 只读面，回答「这个群号对应哪个群 ID / 这个 QQ号是谁 / 什么时候绑的」——
 * `/bind user` / `/bind groupid` 的**写**不搬（高危代绑留在机器人里）。
 * 有绑定表时读表（带时间戳），没有表（纯内存）时退回内存映射（没有时间戳，如实缺省）。
 */
function harness(options: {
  bindings?: IdentityBinding[];
  memoryOnly?: boolean;
}): { backend: AdminApiBackend; identityMap: IdentityMapService } {
  const api = new FakeQQOfficialAPI();
  const writeQueue = new WriteQueue();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const identityMap = new IdentityMapService();
  const backend = createAdminApiBackend({
    permissions: new PermissionService({ superAdminIds: new Set(["boss"]) }),
    auditLog,
    joinAudit,
    joinApproval: new JoinApprovalService(api, joinAudit, configStore),
    configStore,
    activity: new ActivityService(),
    activityExport: new ActivityExportService({ profiles: { get: () => undefined } }),
    database: "sqlite",
    identityMap,
    ...(options.bindings !== undefined
      ? {
          identityBindings: {
            bind: async () => {},
            findAll: async () => options.bindings ?? [],
          },
        }
      : {}),
  });
  return { backend, identityMap };
}

describe("身份映射只读（GET /api/identities）", () => {
  it("有绑定表：读表，按 user / group 分组，带上绑定与改绑时间", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    const updatedAt = new Date("2026-10-01T00:00:00.000Z");
    const { backend } = harness({
      bindings: [
        { kind: "user", officialId: "u1", externalId: "10001", createdAt, updatedAt },
        { kind: "user", officialId: "u2", externalId: "10002" },
        { kind: "group", officialId: "g1", externalId: "50001", createdAt },
      ],
    });

    const view = await backend.identities();

    expect(view.users.map((row) => row.officialId)).toEqual(["u1", "u2"]);
    expect(view.users[0]).toMatchObject({
      externalId: "10001",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    // 老库 / 缺列：如实不带时间，不编一个
    expect(view.users[1]).not.toHaveProperty("createdAt");
    expect(view.groups).toEqual([
      expect.objectContaining({
        officialId: "g1",
        externalId: "50001",
        entity: expect.objectContaining({ kind: "group", label: "g1" }),
      }),
    ]);
  });

  it("没有绑定表（纯内存）：退回内存映射，只有 ID ↔ 绑定号", async () => {
    const { backend, identityMap } = harness({ memoryOnly: true });
    await identityMap.bindUser("u1", "10001");
    await identityMap.bindGroup("g1", "50001");

    const view = await backend.identities();

    expect(view.users).toEqual([
      expect.objectContaining({ officialId: "u1", externalId: "10001" }),
    ]);
    expect(view.groups).toEqual([
      expect.objectContaining({ officialId: "g1", externalId: "50001" }),
    ]);
    expect(view.users[0]).not.toHaveProperty("createdAt");
  });

  it("空表：两条空列表（页面显示「还没有绑定」而不是报错）", async () => {
    const { backend } = harness({ bindings: [] });
    const view = await backend.identities();
    expect(view).toEqual({ users: [], groups: [] });
  });
});
