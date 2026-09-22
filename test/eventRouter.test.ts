import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { ModerationAction } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { EventRouter } from "../src/services/eventRouter.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { MessageGuardService } from "../src/services/messageGuard.js";
import { RuleEngine } from "../src/services/moderation.js";
import { PermissionService } from "../src/services/permissions.js";

describe("EventRouter", () => {
  let api: FakeQQOfficialAPI;
  let joinAudit: JoinAuditService;
  let router: EventRouter;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    const auditLog = new InMemoryAuditLog();
    joinAudit = new JoinAuditService(auditLog);
    const permissions = new PermissionService({
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      moderatorIds: new Map([["g1", new Set(["mod"])]]),
    });
    const configStore = new GroupConfigStore({ groupId: "__default__" });
    const rules = new RuleEngine([
      { ruleId: "warn", pattern: "广告", action: ModerationAction.Warn },
    ]);
    const messageGuard = new MessageGuardService(
      api,
      rules,
      configStore,
      auditLog,
    );
    const adminCommands = new AdminCommandService(
      permissions,
      joinAudit,
      configStore,
    );
    router = new EventRouter(messageGuard, joinAudit, adminCommands);
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
    expect(joinAudit.pending("g1")).toHaveLength(1);
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
