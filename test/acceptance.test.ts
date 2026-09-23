import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { JoinRequestStatus, ModerationAction } from "../src/core/enums.js";
import { createPersistentRuntime } from "./helpers/persistenceRuntime.js";
import { createSqliteTestDatabase } from "./helpers/testDatabases.js";

/**
 * Phase 1 验收「干跑」。
 *
 * 用真实 SQLite 文件 + 官方 API 测试替身，端到端跑通 docs/ACCEPTANCE.md 里
 * 不依赖真实 QQ 平台的验收项（B/C/D/G 组），作为回归保护。
 * 依赖真实平台的部分（真的进群、真的禁言）仍需人工按清单执行。
 */
describe("acceptance dry run (sqlite)", () => {
  it("completes the join approval loop through the official API", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();
      const api = runtime.api as unknown as FakeQQOfficialAPI;
      await runtime.identityMap.bindUser("root", "10001");
      await runtime.identityMap.bindGroup("g1", "654321");

      await runtime.router.handle({
        type: "join_request",
        groupId: "g1",
        userId: "applicant-openid",
        requestId: "r1",
        reason: "想加入",
      });
      const pending = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/pending",
      });
      expect(pending.text).toContain("r1");

      const approve = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/approve r1",
      });

      expect(approve.ok).toBe(true);
      expect(runtime.joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
      expect(api.joinRequestReviews).toEqual([
        {
          groupId: "g1",
          memberOpenid: "applicant-openid",
          op: "approve",
          joinRequestId: "r1",
        },
      ]);
    } finally {
      await database.cleanup();
    }
  });

  it("keeps the request pending when the official approval fails", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();
      const api = runtime.api as unknown as FakeQQOfficialAPI;
      await runtime.identityMap.bindUser("root", "10001");
      await runtime.identityMap.bindGroup("g1", "654321");
      await runtime.router.handle({
        type: "join_request",
        groupId: "g1",
        userId: "applicant-openid",
        requestId: "r1",
      });
      api.failJoinRequestApprovals = true;

      const approve = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/approve r1",
      });

      expect(approve.ok).toBe(false);
      expect(approve.text).toContain("审批失败");
      expect(runtime.joinAudit.get("r1").status).toBe(JoinRequestStatus.Pending);
    } finally {
      await database.cleanup();
    }
  });

  it("configures keywords via /rules set and warns on a hit", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();
      const api = runtime.api as unknown as FakeQQOfficialAPI;
      await runtime.identityMap.bindUser("root", "10001");
      await runtime.identityMap.bindGroup("g1", "654321");

      const configured = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/rules set keywords 测试违禁词",
      });
      expect(configured.ok).toBe(true);
      expect(runtime.configStore.get("g1").keywords).toEqual(["测试违禁词"]);

      const blocked = await runtime.router.handle({
        type: "group_message",
        groupId: "g1",
        userId: "member-openid",
        messageId: "m1",
        content: "这里有测试违禁词",
      });

      expect(blocked.kind).toBe("message");
      expect(blocked.action).toBe(ModerationAction.Warn);
      expect(blocked.executed).toBe(true);
      expect(api.sentMessages.at(-1)?.content).toContain("请遵守群规");
      expect(api.sentMessages.at(-1)?.groupId).toBe("g1");

      const audit = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/audit",
      });
      expect(audit.ok).toBe(true);
      expect(audit.text).toContain("moderation:warn");
    } finally {
      await database.cleanup();
    }
  });

  it("keeps keywords per group and in sync with the database", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();
      await runtime.identityMap.bindUser("root", "10001");
      await runtime.identityMap.bindGroup("g1", "654321");
      await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/rules set keywords 广告",
      });

      const other = await runtime.router.handle({
        type: "group_message",
        groupId: "g2",
        userId: "member-openid",
        messageId: "m2",
        content: "广告",
      });
      expect(other.action).toBe(ModerationAction.Allow);

      await runtime.flush();
      const restarted = createPersistentRuntime(
        await database.restart(),
        "root",
      );
      await restarted.load();
      expect(restarted.configStore.get("g1").keywords).toEqual(["广告"]);
    } finally {
      await database.cleanup();
    }
  });

  it("shows limited help for unbound users", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();

      const help = await runtime.router.handle({
        type: "private_message",
        userId: "stranger",
        messageId: "pm1",
        content: "/help",
      });

      expect(help.ok).toBe(true);
      expect(help.text).toContain("/bind qq");
      expect(help.text).not.toContain("/perm");
      expect(help.text).not.toContain("/approve");
    } finally {
      await database.cleanup();
    }
  });

  it("restores approved requests, audit records and keywords after restart", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();
      await runtime.identityMap.bindUser("root", "10001");
      await runtime.identityMap.bindGroup("g1", "654321");

      await runtime.router.handle({
        type: "join_request",
        groupId: "g1",
        userId: "applicant-openid",
        requestId: "r1",
      });
      await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/approve r1",
      });
      await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/rules set keywords 广告",
      });
      await runtime.router.handle({
        type: "group_message",
        groupId: "g1",
        userId: "member-openid",
        messageId: "m1",
        content: "广告内容",
      });
      await runtime.flush();

      const restarted = createPersistentRuntime(
        await database.restart(),
        "root",
      );
      await restarted.load();

      expect(restarted.joinAudit.get("r1").status).toBe(
        JoinRequestStatus.Approved,
      );
      expect(restarted.configStore.get("g1").keywords).toEqual(["广告"]);
      const actions = restarted.auditLog
        .findByGroup("g1")
        .map((record) => record.action);
      expect(actions).toContain("approve_join_request");
      expect(actions).toContain("moderation:warn");
    } finally {
      await database.cleanup();
    }
  });
});
