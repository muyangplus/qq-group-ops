import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
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
 * P3：**权限授予 / 撤销**（`/perm` 的管理面）。
 *
 * 这是「权限的权限」，所以口径收得很紧：
 * - 门槛是**平台超管 240**（与指令层 `/perm` 一致），没有第二个入口；
 * - 走同一个 `PermissionService`（同源），领域层护栏照旧生效（不能撤掉最后一个超管）；
 * - 管理面多加一条护栏：**不能撤销自己的全局超管**（点一下就把自己锁死）；
 * - 每条写都写 `admin_api:perm_grant` / `admin_api:perm_revoke` 审计，
 *   撤销本来就不存在的授权如实回 `changed: false`（审计记 rejected）。
 */
interface Harness {
  backend: AdminApiBackend;
  permissions: PermissionService;
  auditLog: AuditLogStore;
  identityMap: IdentityMapService;
}

function harness(): Harness {
  const api = new FakeQQOfficialAPI();
  const writeQueue = new WriteQueue();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  // `boss` 是唯一的全局超管；`admin` 是 g1 的群管理员但**不是**平台超管
  const permissions = new PermissionService({
    superAdminIds: new Set(["boss"]),
  });
  permissions.grantGroupAdmin("g1", "admin");
  const identityMap = new IdentityMapService();
  const backend = createAdminApiBackend({
    permissions,
    auditLog,
    joinAudit,
    joinApproval: new JoinApprovalService(api, joinAudit, configStore),
    configStore,
    activity: new ActivityService(),
    activityExport: new ActivityExportService({ profiles: { get: () => undefined } }),
    database: "sqlite",
    identityMap,
  });
  return { backend, permissions, auditLog, identityMap };
}

describe("权限总览（GET /api/permissions）", () => {
  it("全局角色 + 有授权的群；选了群再给三个群内角色", async () => {
    const h = harness();
    h.permissions.grantModerator("g1", "u1");
    h.permissions.grantGroupSuperAdmin("g2", "u2");

    const all = await h.backend.permissions({});
    expect(all.global).toHaveLength(1);
    expect(all.global[0]).toMatchObject({
      role: "super",
      roleLabel: "全局超级管理员",
      members: [{ userId: "boss" }],
    });
    expect(all.group).toBeUndefined();
    expect(all.groups.map((row) => row.groupId)).toEqual(["g1", "g2"]);

    const group = await h.backend.permissions({ group: "g1" });
    expect(group.group?.roles.map((role) => role.role)).toEqual([
      "group_super",
      "group_admin",
      "moderator",
    ]);
    expect(
      group.group?.roles.find((role) => role.role === "group_admin")?.members,
    ).toEqual([{ userId: "admin", user: expect.objectContaining({ kind: "user" }) }]);
    expect(
      group.group?.roles.find((role) => role.role === "moderator")?.members.map(
        (member) => member.userId,
      ),
    ).toEqual(["u1"]);
  });

  it("选了一个还没有授权的群：groups 里也要带上它（选择器不跳）", async () => {
    const h = harness();
    const view = await h.backend.permissions({ group: "g9" });
    expect(view.groups.map((row) => row.groupId)).toContain("g9");
    expect(view.group?.roles.every((role) => role.members.length === 0)).toBe(true);
  });
});

describe("授予 / 撤销（POST /api/permissions）", () => {
  it("授予群管理员：changed = true、名单更新、写审计", async () => {
    const h = harness();
    const result = await h.backend.setPermission({
      action: "grant",
      role: "group_admin",
      group: "g1",
      userId: "u1",
      actorId: "boss",
    });

    expect(result).toMatchObject({
      action: "grant",
      role: "group_admin",
      roleLabel: "群管理员",
      changed: true,
    });
    expect(result.members.map((member) => member.userId)).toEqual(["admin", "u1"]);
    expect(result.message).toContain("已授予");
    expect(h.permissions.listGroupAdmins("g1")).toEqual(["admin", "u1"]);
    const audit = h.auditLog.all().find((row) => row.action === "admin_api:perm_grant");
    expect(audit?.status).toBe("executed");
    expect(audit?.groupId).toBe("g1");
    expect(audit?.reason).toContain("群管理员");
  });

  it("重复授予 / 撤销不存在的授权：changed = false，审计记 rejected", async () => {
    const h = harness();

    const again = await h.backend.setPermission({
      action: "grant",
      role: "group_admin",
      group: "g1",
      userId: "admin",
      actorId: "boss",
    });
    expect(again.changed).toBe(false);
    expect(again.message).toContain("本来就有");

    const missing = await h.backend.setPermission({
      action: "revoke",
      role: "moderator",
      group: "g1",
      userId: "nobody",
      actorId: "boss",
    });
    expect(missing.changed).toBe(false);
    expect(missing.message).toContain("本来就没有");

    const statuses = h.auditLog
      .all()
      .filter((row) => row.action.startsWith("admin_api:perm_"))
      .map((row) => row.status);
    expect(statuses).toEqual(["rejected", "rejected"]);
  });

  it("撤销：真删掉时 changed = true，名单里少一个", async () => {
    const h = harness();
    const result = await h.backend.setPermission({
      action: "revoke",
      role: "group_admin",
      group: "g1",
      userId: "admin",
      actorId: "boss",
    });
    expect(result.changed).toBe(true);
    expect(result.members).toEqual([]);
    expect(h.permissions.listGroupAdmins("g1")).toEqual([]);
    expect(
      h.auditLog.all().some((row) => row.action === "admin_api:perm_revoke"),
    ).toBe(true);
  });

  it("全局超管：能授予别人；但**不能撤销自己**（会把自己锁死）", async () => {
    const h = harness();
    const granted = await h.backend.setPermission({
      action: "grant",
      role: "super",
      userId: "u2",
      actorId: "boss",
    });
    expect(granted.changed).toBe(true);
    expect(h.permissions.listSuperAdmins()).toEqual(["boss", "u2"]);

    await expect(
      h.backend.setPermission({
        action: "revoke",
        role: "super",
        userId: "boss",
        actorId: "boss",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    // 自己还在（护栏生效，不是「先删了再报错」）
    expect(h.permissions.listSuperAdmins()).toContain("boss");
  });

  it("两个超管之间可以互相撤；领域层仍然拦「最后一个」（只能从服务层触发）", async () => {
    const h = harness();
    await h.backend.setPermission({
      action: "grant",
      role: "super",
      userId: "u2",
      actorId: "boss",
    });
    const revoked = await h.backend.setPermission({
      action: "revoke",
      role: "super",
      userId: "boss",
      actorId: "u2",
    });
    expect(revoked.changed).toBe(true);
    expect(h.permissions.listSuperAdmins()).toEqual(["u2"]);
    // 管理面有「不能撤销自己」的护栏，所以领域层这条只能直接从服务层触发
    expect(() => h.permissions.revokeSuperAdmin("u2")).toThrow(/last super admin/u);
  });

  it("群角色必须带 group；未知角色 / 非法 action 一律 400 语义", async () => {
    const h = harness();
    await expect(
      h.backend.setPermission({
        action: "grant",
        role: "group_admin",
        userId: "u1",
        actorId: "boss",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    await expect(
      h.backend.setPermission({
        action: "grant",
        role: "nope",
        group: "g1",
        userId: "u1",
        actorId: "boss",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    await expect(
      h.backend.setPermission({
        action: "grant",
        role: "moderator",
        group: "g1",
        userId: "",
        actorId: "boss",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
  });

  it("门槛：只有平台超管（240）能改权限，群管理员也不行", async () => {
    const h = harness();
    await expect(
      h.backend.setPermission({
        action: "grant",
        role: "moderator",
        group: "g1",
        userId: "u1",
        actorId: "admin",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    expect(h.permissions.listModerators("g1")).toEqual([]);
  });

  it("目标可以是已绑定的 QQ号（与指令层同一套身份映射）", async () => {
    const h = harness();
    await h.identityMap.bindUser("u-openid", "10001");

    const byQq = await h.backend.setPermission({
      action: "grant",
      role: "moderator",
      group: "g1",
      userId: "10001",
      actorId: "boss",
    });
    expect(byQq.members.map((member) => member.userId)).toContain("u-openid");
    expect(h.permissions.listModerators("g1")).toContain("u-openid");

    // 群也可以用群号（内部 id ↔ 群号的映射在 identityMap 里）
    await h.identityMap.bindGroup("g1", "50001");
    const byNumber = await h.backend.setPermission({
      action: "grant",
      role: "moderator",
      group: "50001",
      userId: "u-openid",
      actorId: "boss",
    });
    expect(byNumber.group?.officialId).toBe("g1");
  });
});
