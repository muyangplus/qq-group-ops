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
  it("pushes a join request card and approves it through the button command", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();
      const api = runtime.api as unknown as FakeQQOfficialAPI;
      await runtime.identityMap.bindUser("root", "10001");
      await runtime.identityMap.bindGroup("g1", "654321");

      // 审核员开启推送
      const subscribed = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/notify on",
      });
      expect(subscribed.ok).toBe(true);

      // 新申请 → 私聊推送卡片（含快捷按钮）
      const join = await runtime.router.handle({
        type: "join_request",
        groupId: "g1",
        userId: "applicant-openid",
        requestId: "r1",
        reason: "材化2211 张三",
      });
      expect(join.detail).toBe("queued");
      expect(api.sentPrivateMessages).toHaveLength(1);
      const card = api.sentPrivateMessages[0]!;
      expect(card.markdown).toContain("新的入群申请");
      const buttons = (
        card.keyboard as {
          content: {
            rows: Array<{ buttons: Array<{ action: { data: string } }> }>;
          };
        }
      ).content.rows[0]!.buttons;
      expect(buttons[0]!.action.data).toMatch(
        /^\/approve #[0-9A-Za-z]{6}$/u,
      );
      expect(card.markdown).toMatch(/#[0-9A-Za-z]{6}/u);
      expect(card.markdown).not.toContain("applicant-openid");

      // 点击按钮等价于在私聊里发送该指令
      const approve = await runtime.router.handle({
        type: "private_message",
        userId: "root",
        messageId: "pm1",
        content: buttons[0]!.action.data,
      });
      expect(approve.ok).toBe(true);
      expect(runtime.joinAudit.get("r1").status).toBe(
        JoinRequestStatus.Approved,
      );

      // 订阅与投递记录都持久化：重启后不会重复推送
      await runtime.flush();
      const restarted = createPersistentRuntime(
        await database.restart(),
        "root",
      );
      await restarted.load();
      expect(restarted.notifications.listScopes("root")).toContain("g1");
      const again = await restarted.notifications.notifyJoinRequest({
        groupId: "g1",
        requestId: "r1",
        userId: "applicant-openid",
        reason: "材化2211 张三",
      });
      expect(again.skipped).toBe(1);
    } finally {
      await database.cleanup();
    }
  });

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
      // /pending 只展示短码；用短码审批（同时验证旧的完整 id 仍然兼容）
      expect(pending.text).toMatch(/#[0-9A-Za-z]{6}/u);
      expect(pending.text).not.toContain("r1");
      const shortCode = /#[0-9A-Za-z]{6}/u.exec(pending.text)?.[0];
      expect(shortCode).toBeDefined();

      const approveByCode = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: `/approve ${shortCode}`,
      });
      expect(approveByCode.ok).toBe(true);
      expect(approveByCode.text).toContain(shortCode ?? "");
      expect(runtime.joinAudit.get("r1").status).toBe(
        JoinRequestStatus.Approved,
      );

      // 兼容：直接传完整 join_request_id 也能审批（第二个申请）
      await runtime.router.handle({
        type: "join_request",
        groupId: "g1",
        userId: "applicant-2",
        requestId: "r2",
        reason: "想加入",
      });
      const approve = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/approve r2",
      });
      expect(approve.ok).toBe(true);
      expect(runtime.joinAudit.get("r2").status).toBe(
        JoinRequestStatus.Approved,
      );
      expect(api.joinRequestReviews).toEqual([
        {
          groupId: "g1",
          memberOpenid: "applicant-openid",
          op: "approve",
          joinRequestId: "r1",
        },
        {
          groupId: "g1",
          memberOpenid: "applicant-2",
          op: "approve",
          joinRequestId: "r2",
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
      // B2：命中反馈是一张卡片（@ 当事人 + 命中规则 + 处理动作 + 群规则文案），被动回复原消息
      const warning = api.sentMessages.at(-1);
      expect(warning?.groupId).toBe("g1");
      expect(warning?.msgId).toBe("m1");
      const warningText = String(warning?.markdown ?? warning?.content ?? "");
      expect(warningText).toContain("<@!member-openid>");
      expect(warningText).toContain("命中规则");
      expect(warningText).toContain("仅警告");
      expect(warningText).toContain("请遵守群规");

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

  it("applies global rules to groups without their own configuration", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();
      await runtime.identityMap.bindUser("root", "10001");
      await runtime.identityMap.bindGroup("g1", "654321");

      const global = await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/rules set all keywords 全局违禁词",
      });
      expect(global.ok).toBe(true);
      expect(runtime.configStore.default.keywords).toEqual(["全局违禁词"]);

      // 未单独配置的群继承全局关键词
      const inherited = await runtime.router.handle({
        type: "group_message",
        groupId: "g1",
        userId: "member-openid",
        messageId: "m1",
        content: "这里包含全局违禁词",
      });
      expect(inherited.action).toBe(ModerationAction.Warn);

      // 群内单独配置关键词后以群配置为准
      await runtime.router.handle({
        type: "admin_command",
        groupId: "g1",
        userId: "root",
        text: "/rules set keywords 本群违禁词",
      });
      const globalWordNowAllowed = await runtime.router.handle({
        type: "group_message",
        groupId: "g1",
        userId: "member-openid",
        messageId: "m2",
        content: "这里包含全局违禁词",
      });
      expect(globalWordNowAllowed.action).toBe(ModerationAction.Allow);

      const groupWord = await runtime.router.handle({
        type: "group_message",
        groupId: "g1",
        userId: "member-openid",
        messageId: "m3",
        content: "这里包含本群违禁词",
      });
      expect(groupWord.action).toBe(ModerationAction.Warn);

      // 全局规则持久化，重启后仍然生效
      await runtime.flush();
      const restarted = createPersistentRuntime(
        await database.restart(),
        "root",
      );
      await restarted.load();
      expect(restarted.configStore.default.keywords).toEqual(["全局违禁词"]);
      expect(restarted.configStore.get("brand-new-group").keywords).toEqual([
        "全局违禁词",
      ]);
      expect(restarted.configStore.get("g1").keywords).toEqual(["本群违禁词"]);
    } finally {
      await database.cleanup();
    }
  });

  it("shows limited help for unbound users", async () => {    const database = await createSqliteTestDatabase();
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

  it("restores approved requests, audit records and keywords after restart", async () => {    const database = await createSqliteTestDatabase();
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
