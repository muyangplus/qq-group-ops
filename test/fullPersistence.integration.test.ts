import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import {
  AuditStatus,
  JoinRequestStatus,
  PermissionLevel,
} from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import { createPersistentRuntime } from "./helpers/persistenceRuntime.js";
import { TEST_DATABASES } from "./helpers/testDatabases.js";

for (const driver of TEST_DATABASES) {
  describe(`full persistence across restart [${driver.name}]`, () => {
    it("restores every stateful service from the database", async () => {
      const database = await driver.create();
      try {
        const first = createPersistentRuntime(database.queryable);
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
        first.notifications.subscribe("admin", "g1");
        first.notifications.subscribe("admin", "__all__");
        await first.notifications.notifyJoinRequest({
          groupId: "g1",
          requestId: "r1",
          userId: "u1",
          reason: "想加入",
        });

        await first.flush();

        const restarted = createPersistentRuntime(await database.restart());
        await restarted.load();

        expect(restarted.notifications.listScopes("admin")).toEqual([
          "__all__",
          "g1",
        ]);
        // 投递记录也会恢复：同一申请不会重复推送
        const pushAgain = await restarted.notifications.notifyJoinRequest({
          groupId: "g1",
          requestId: "r1",
          userId: "u1",
          reason: "想加入",
        });
        expect(pushAgain.skipped).toBe(1);
        expect(
          (restarted.api as FakeQQOfficialAPI).sentPrivateMessages,
        ).toEqual([]);

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
      } finally {
        await database.cleanup();
      }
    });

    it("uses ADMIN_USER_IDS only to seed an empty permission table", async () => {
      const database = await driver.create();
      try {
        const first = createPersistentRuntime(database.queryable, "root");
        await first.load();
        expect(first.permissions.isSuperAdmin("root")).toBe(true);

        first.permissions.grantSuperAdmin("second-root");
        first.permissions.revokeSuperAdmin("root");
        await first.flush();

        const restarted = createPersistentRuntime(
          await database.restart(),
          "root",
        );
        await restarted.load();

        expect(restarted.permissions.isSuperAdmin("root")).toBe(false);
        expect(restarted.permissions.isSuperAdmin("second-root")).toBe(true);
      } finally {
        await database.cleanup();
      }
    });

    it("keeps group super admins scoped and still seeds a global super admin", async () => {
      const database = await driver.create();
      try {
        const first = createPersistentRuntime(database.queryable, "root");
        await first.load();
        first.permissions.grantGroupSuperAdmin("g1", "owner1");
        await first.flush();

        const restarted = createPersistentRuntime(
          await database.restart(),
          "root",
        );
        await restarted.load();

        // 本群超管只在 g1 生效，且不是全局超管
        expect(restarted.permissions.isGroupSuperAdmin("owner1", "g1")).toBe(true);
        expect(restarted.permissions.levelFor("owner1", "g1")).toBe(
          PermissionLevel.SuperAdmin,
        );
        expect(restarted.permissions.isSuperAdmin("owner1")).toBe(false);
        expect(restarted.permissions.levelFor("owner1", "g2")).toBe(
          PermissionLevel.Member,
        );

        // 数据库里只有本群超管时，仍然要用 ADMIN_USER_IDS 种子全局超管
        expect(restarted.permissions.isSuperAdmin("root")).toBe(true);
      } finally {
        await database.cleanup();
      }
    });

    it("removes deleted group config overrides and keywords from the database", async () => {      const database = await driver.create();
      try {
        const first = createPersistentRuntime(database.queryable);
        await first.load();
        first.configStore.setOverride({
          groupId: "g1",
          keywords: ["广告"],
          autoApproveJoin: true,
        });
        await first.flush();
        first.configStore.removeOverride("g1");
        await first.flush();

        const restarted = createPersistentRuntime(await database.restart());
        await restarted.load();

        expect(restarted.configStore.listOverrides()).toEqual([]);
        expect(restarted.configStore.get("g1").autoApproveJoin).toBe(false);
      } finally {
        await database.cleanup();
      }
    });
  });
}
