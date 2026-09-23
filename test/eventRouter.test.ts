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
      reason: "想加入",
    });

    expect(result.detail).toBe("queued");
    expect(api.sentPrivateMessages).toHaveLength(1);
    const message = api.sentPrivateMessages[0]!;
    expect(message.userOpenid).toBe("admin");
    expect(message.markdown).toContain("新的入群申请");
    const buttons = (
      message.keyboard as {
        content: { rows: Array<{ buttons: Array<{ action: { data: string } }> }> };
      }
    ).content.rows[0]!.buttons;
    expect(buttons[0]!.action.data).toBe("/approve g1 r1");
    expect(buttons[1]!.action.data).toContain("/reject g1 r1");
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
