import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { ModerationAction } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { AuditLogStore } from "../src/services/audit.js";
import { EventRouter } from "../src/services/eventRouter.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";
import { MessageGuardService } from "../src/services/messageGuard.js";
import { RuleEngine } from "../src/services/moderation.js";
import { NotificationService } from "../src/services/notifications.js";
import { PermissionService } from "../src/services/permissions.js";

describe("EventRouter", () => {
  let api: FakeQQOfficialAPI;
  let joinAudit: JoinAuditService;
  let configStore: GroupConfigStore;
  let notifications: NotificationService;
  let router: EventRouter;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    const auditLog = new AuditLogStore();
    joinAudit = new JoinAuditService(auditLog);
    const permissions = new PermissionService({
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      moderatorIds: new Map([["g1", new Set(["mod"])]]),
    });
    configStore = new GroupConfigStore({ groupId: "__default__" });
    const rules = new RuleEngine([
      { ruleId: "warn", pattern: "广告", action: ModerationAction.Warn },
    ]);
    const messageGuard = new MessageGuardService(
      api,
      rules,
      configStore,
      auditLog,
    );
    const joinApproval = new JoinApprovalService(api, joinAudit, configStore);
    const joinSync = new JoinRequestSyncService(api, joinAudit, {
      minIntervalMs: 0,
    });
    const adminCommands = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
    });
    notifications = new NotificationService(api, permissions, { configStore });
    router = new EventRouter(
      messageGuard,
      permissions,
      joinAudit,
      adminCommands,
      joinApproval,
      notifications,
    );
  });

  it("pushes pending join requests to subscribed reviewers with quick buttons", async () => {
    notifications.subscribe("admin", "g1");

    const result = await router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "环工2214 小明",
      applicantName: "小明",
      verifyMethod: "admin_review_qa",
      applySource: "self_apply",
      questions: ["请回答班级+姓名"],
    });

    expect(result.detail).toBe("queued");
    expect(api.sentPrivateMessages).toHaveLength(1);
    const message = api.sentPrivateMessages[0]!;
    expect(message.userOpenid).toBe("admin");
    expect(message.markdown).toContain("新的入群申请");
    expect(message.markdown).toContain("**回答**：环工2214 小明");
    expect(message.markdown).toContain("**申请人**：u1（小明）");
    expect(message.markdown).toContain("**入群问题**：请回答班级+姓名");
    const buttons = (
      message.keyboard as {
        content: { rows: Array<{ buttons: Array<{ action: { data: string } }> }> };
      }
    ).content.rows[0]!.buttons;
    expect(buttons[0]!.action.data).toBe("/approve r1");
    expect(buttons[1]!.action.data).toContain("/reject r1");
  });

  it("does not push join requests that are decided automatically", async () => {
    configStore.setOverride({ groupId: "g1", autoApproveJoin: true });
    notifications.subscribe("admin", "g1");

    const result = await router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });

    expect(result.detail).toBe("auto_approved");
    expect(api.sentPrivateMessages).toEqual([]);
  });

  it("pushes an informational card for auto decisions when notifyAutoApproved is on", async () => {
    configStore.setOverride({
      groupId: "g1",
      autoApproveJoin: true,
      notifyAutoApproved: true,
    });
    notifications.subscribe("admin", "g1");

    const result = await router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });

    expect(result.detail).toBe("auto_approved");
    expect(api.sentPrivateMessages).toHaveLength(1);
    const message = api.sentPrivateMessages[0]!;
    expect(message.markdown).toContain("**处理结果**：已自动通过（按入群规则）");
    expect(message.markdown).toContain("无需操作");
    // 已自动处理：不给审批按钮；但推送卡统一带一行「取消订阅此通知」
    const keyboard = message.keyboard as
      | { content: { rows: ReadonlyArray<{ buttons: ReadonlyArray<{ action: { data: string } }> }> } }
      | undefined;
    const rows = keyboard?.content.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.buttons.map((button) => button.action.data)).toEqual([
      "cb:notify:unsub:join:g1",
    ]);
  });

  it("handles duplicate join request events without throwing or pushing twice", async () => {
    notifications.subscribe("admin", "g1");
    const event = {
      type: "join_request" as const,
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    };

    const first = await router.handle(event);
    const second = await router.handle(event);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(joinAudit.pending("g1")).toHaveLength(1);
    expect(api.sentPrivateMessages).toHaveLength(1);
  });

  it("routes group messages through the guard service", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "u1",
      messageId: "m1",
      content: "这是广告",
    });
    expect(result.kind).toBe("message");
    expect(result.action).toBe(ModerationAction.Warn);
    expect(api.sentMessages).toHaveLength(1);
  });

  /**
   * 空正文的消息只有**真的 @ 了机器人**时才回常用菜单（2026-10-12 真机修复）。
   *
   * 全量消息模式（`GROUP_MESSAGE_CREATE`）下图片 / 文件 / 语音的正文就是空的：之前会被
   * 当成「空 @机器人」，一次发 N 张图片就回 N 张菜单卡、@ 用户 N 次。
   */
  it("ignores an empty group message that does not mention the bot", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "member",
      messageId: "m1",
      content: "",
    });

    expect(result.kind).toBe("message");
    expect(result.detail).toBe("empty_not_mentioned");
    expect(api.sentMessages).toHaveLength(0);
  });

  it("still returns the main menu for an empty group mention", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m2",
      content: "",
      mentioned: true,
    });

    expect(result.kind).toBe("command");
    expect(String(result.rich?.markdown ?? result.text ?? "")).toContain("常用菜单");
  });

  it("returns the main menu when the bot is mentioned with plain text (not a command)", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m3",
      content: "你好",
      mentioned: true,
    });

    expect(result.kind).toBe("command");
    expect(String(result.rich?.markdown ?? result.text ?? "")).toContain("常用菜单");
  });

  it("does not add the menu when the mentioned message already hit a rule", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "u1",
      messageId: "m4",
      content: "这是广告",
      mentioned: true,
    });

    // 命中规则：照旧走审核（回处罚卡），**不**再叠一张常用菜单
    expect(result.kind).toBe("message");
    expect(result.action).toBe(ModerationAction.Warn);
    expect(api.sentMessages).toHaveLength(1);
    expect(String(api.sentMessages[0]?.content ?? "")).not.toContain("常用菜单");
  });

  /**
   * ADR-0074（用户口径 2026-10-15）：群里**审核员以下**的消息「一条都不回」——
   * 含 `/指令` 与 `@机器人`，也不回「权限不足」；**唯一例外是命中规则的审查处置**
   * （撤回 / 禁言 / 处罚卡照旧，那是机器人的本职，不算「响应消息」）。
   */
  it("does not respond to a below-moderator group command", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "member",
      messageId: "n1",
      content: "/test",
    });

    expect(result.kind).toBe("message");
    expect(result.action).toBe(ModerationAction.Allow);
    expect(result.rich).toBeUndefined();
    expect(api.sentMessages).toHaveLength(0);
  });

  it("does not return the menu when a below-moderator mentions the bot", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "member",
      messageId: "n2",
      content: "你好",
      mentioned: true,
    });

    expect(result.kind).toBe("message");
    expect(api.sentMessages).toHaveLength(0);
  });

  it("still moderates a below-moderator message that hits a rule", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "member",
      messageId: "n3",
      content: "这是广告",
    });

    expect(result.kind).toBe("message");
    expect(result.action).toBe(ModerationAction.Warn);
    expect(api.sentMessages).toHaveLength(1);
  });

  it("keeps moderating a below-moderator slash-looking message (no /-prefix escape)", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "member",
      messageId: "n4",
      content: "/这是广告",
    });

    expect(result.kind).toBe("message");
    expect(result.action).toBe(ModerationAction.Warn);
    expect(api.sentMessages).toHaveLength(1);
  });

  it("keeps member commands working in private messages", async () => {
    const result = await router.handle({
      type: "private_message",
      userId: "member",
      messageId: "pm1",
      content: "/menu",
    });

    expect(result.kind).toBe("private_message");
    expect(result.ok).toBe(true);
    expect(String(result.rich?.markdown ?? result.text ?? "")).toContain("常用菜单");
  });

  it("queues join requests", async () => {
    const result = await router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });
    expect(result.kind).toBe("join_request");
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("queued");
    expect(joinAudit.pending("g1")).toHaveLength(1);
    expect(api.joinRequestReviews).toEqual([]);
  });

  it("auto approves join requests when the group config enables it", async () => {
    configStore.setOverride({ groupId: "g1", autoApproveJoin: true });

    const result = await router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });

    expect(result.detail).toBe("auto_approved");
    expect(api.joinRequestReviews).toEqual([
      { groupId: "g1", memberOpenid: "u1", op: "approve", joinRequestId: "r1" },
    ]);
    expect(joinAudit.get("r1").status).toBe("approved");
  });

  it("routes admin commands", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await router.handle({
      type: "admin_command",
      groupId: "g1",
      userId: "mod",
      text: "/pending",
    });
    expect(result.kind).toBe("command");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("r1");
  });

  it("routes group message slash commands to admin commands", async () => {
    const result = await router.handle({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m1",
      content: "/test",
    });
    expect(result.kind).toBe("command");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("测试成功");
  });

  it("routes private slash commands", async () => {
    const result = await router.handle({
      type: "private_message",
      userId: "root",
      messageId: "pm1",
      content: "/bind qq 123456",
    });
    expect(result.kind).toBe("private_message");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已绑定");
  });
});
