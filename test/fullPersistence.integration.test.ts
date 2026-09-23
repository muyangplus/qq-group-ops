import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import { AuditStatus, JoinRequestStatus } from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import { PostgresActivityRepository } from "../src/db/activityRepository.js";
import { PostgresAuditRepository } from "../src/db/auditRepository.js";
import { PostgresGroupConfigRepository } from "../src/db/groupConfigRepository.js";
import { PostgresGroupMessageModeRepository } from "../src/db/groupMessageModeRepository.js";
import { PostgresIdentityBindingRepository } from "../src/db/identityBindingRepository.js";
import { PostgresJoinRequestRepository } from "../src/db/joinRequestRepository.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresPermissionRepository } from "../src/db/permissionRepository.js";
import type { PgQueryable } from "../src/db/pgQueryable.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { createPgMemQueryable } from "./helpers/pgMem.js";

async function createDatabase(): Promise<PgQueryable> {
  const queryable = createPgMemQueryable();
  await migrate(queryable);
  return queryable;
}

function buildRuntime(queryable: PgQueryable, adminUserIds = "root"): Runtime {
  return createRuntime(loadSettings({ ADMIN_USER_IDS: adminUserIds }), {
    repositories: {
      audit: new PostgresAuditRepository(queryable),
      joinRequests: new PostgresJoinRequestRepository(queryable),
      groupConfigs: new PostgresGroupConfigRepository(queryable),
      identityBindings: new PostgresIdentityBindingRepository(queryable),
      groupMessageModes: new PostgresGroupMessageModeRepository(queryable),
      permissions: new PostgresPermissionRepository(queryable),
      activities: new PostgresActivityRepository(queryable),
    },
  });
}

describe("full persistence across restart (pg-mem)", () => {
  it("restores every stateful service from PostgreSQL", async () => {
    const queryable = await createDatabase();

    const first = buildRuntime(queryable);
    await first.load();

    await first.identityMap.bindUser("root", "10001");
    await first.identityMap.bindGroup("g1", "654321");
    first.permissions.grantSuperAdmin("second-root");
    first.permissions.grantGroupAdmin("g1", "admin");
    first.permissions.grantModerator("g1", "mod");
    first.joinAudit.submit("g1", "u1", "想加入", "r1");
    first.joinAudit.approve("r1", "admin");
    first.configStore.setOverride({
      groupId: "g1",
      autoApproveJoin: true,
      keywords: ["广告", "刷屏"],
    });
    first.groupMessageMode.setEnabled("g1", true);
    first.activity.createActivity({
      groupId: "g1",
      title: "周末活动",
      createdBy: "admin",
      activityId: "a1",
      capacity: 2,
    });
    first.activity.openActivity("a1");
    first.activity.register({
      activityId: "a1",
      userId: "u1",
      displayName: "小明",
      registrationId: "reg1",
    });
    first.auditLog.append({
      recordId: "rec1",
      groupId: "g1",
      actorId: "admin",
      action: "manual_note",
      status: AuditStatus.Executed,
      reason: "test",
      createdAt: utcNow(),
    });

    await first.flush();

    const restarted = buildRuntime(queryable);
    await restarted.load();

    expect(restarted.identityMap.getQq("root")).toBe("10001");
    expect(restarted.identityMap.getGroupNumber("g1")).toBe("654321");
    expect(restarted.permissions.isSuperAdmin("root")).toBe(true);
    expect(restarted.permissions.isSuperAdmin("second-root")).toBe(true);
    expect(restarted.permissions.canApproveJoin("admin", "g1")).toBe(true);
    expect(restarted.permissions.canReviewContent("mod", "g1")).toBe(true);
    expect(restarted.joinAudit.get("r1").status).toBe(
      JoinRequestStatus.Approved,
    );
    expect(restarted.joinAudit.get("r1").reviewerId).toBe("admin");
    const config = restarted.configStore.get("g1");
    expect(config.autoApproveJoin).toBe(true);
    expect(config.keywords).toEqual(["刷屏", "广告"]);
    expect(restarted.groupMessageMode.get("g1")).toBe("all");
    expect(restarted.activity.getActivity("a1").status).toBe("open");
    expect(restarted.activity.listRegistrations("a1")).toEqual([
      expect.objectContaining({
        registrationId: "reg1",
        userId: "u1",
        displayName: "小明",
      }),
    ]);
    const auditActions = restarted.auditLog
      .findByGroup("g1")
      .map((record) => record.action);
    expect(auditActions).toContain("manual_note");
    expect(auditActions).toContain("approve_join_request");
  });

  it("uses ADMIN_USER_IDS only to seed an empty permission table", async () => {
    const queryable = await createDatabase();

    const first = buildRuntime(queryable, "root");
    await first.load();
    expect(first.permissions.isSuperAdmin("root")).toBe(true);

    first.permissions.grantSuperAdmin("second-root");
    first.permissions.revokeSuperAdmin("root");
    await first.flush();

    const restarted = buildRuntime(queryable, "root");
    await restarted.load();

    expect(restarted.permissions.isSuperAdmin("root")).toBe(false);
    expect(restarted.permissions.isSuperAdmin("second-root")).toBe(true);
  });

  it("removes deleted group config overrides and keywords from the database", async () => {
    const queryable = await createDatabase();

    const first = buildRuntime(queryable);
    await first.load();
    first.configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      autoApproveJoin: true,
    });
    await first.flush();
    first.configStore.removeOverride("g1");
    await first.flush();

    const restarted = buildRuntime(queryable);
    await restarted.load();

    expect(restarted.configStore.listOverrides()).toEqual([]);
    expect(restarted.configStore.get("g1").autoApproveJoin).toBe(false);
  });
});
