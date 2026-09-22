import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AuditStatus, ModerationAction } from "../src/core/enums.js";
import { newIncomingMessage } from "../src/core/models.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { MessageGuardService } from "../src/services/messageGuard.js";
import { RuleEngine } from "../src/services/moderation.js";

describe("MessageGuardService", () => {
  let api: FakeQQOfficialAPI;
  let auditLog: InMemoryAuditLog;
  let configStore: GroupConfigStore;
  let service: MessageGuardService;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    auditLog = new InMemoryAuditLog();
    configStore = new GroupConfigStore({ groupId: "__default__" });
    const rules = new RuleEngine([
      { ruleId: "warn", pattern: "广告", action: ModerationAction.Warn, reason: "发现广告" },
      { ruleId: "recall", pattern: "违规", action: ModerationAction.Recall, reason: "发现违规内容" },
      { ruleId: "mute", pattern: "刷屏", action: ModerationAction.Mute, reason: "发现刷屏" },
      { ruleId: "kick", pattern: "炸群", action: ModerationAction.Kick, reason: "发现炸群" },
      { ruleId: "review", pattern: "可疑", action: ModerationAction.Review, reason: "需要人工复核" },
    ]);
    service = new MessageGuardService(api, rules, configStore, auditLog);
  });

  it("allows normal messages", async () => {
    const result = await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "正常聊天"));
    expect(result.action).toBe(ModerationAction.Allow);
    expect(result.executed).toBe(false);
    expect(api.sentMessages).toEqual([]);
    expect(auditLog.all()).toEqual([]);
  });

  it("warns and writes audit log", async () => {
    const result = await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "这是广告"));
    expect(result.action).toBe(ModerationAction.Warn);
    expect(result.executed).toBe(true);
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0]?.msgId).toBe("m1");
    expect(auditLog.all()[0]?.status).toBe(AuditStatus.Executed);
    expect(auditLog.all()[0]?.action).toBe("moderation:warn");
  });

  it("recalls violating messages", async () => {
    const result = await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "违规内容"));
    expect(result.action).toBe(ModerationAction.Recall);
    expect(api.recalledMessages).toEqual([["g1", "m1"]]);
  });

  it("mutes using group config", async () => {
    configStore.setOverride({ groupId: "g1", muteDurationSeconds: 120 });
    const result = await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "刷屏内容"));
    expect(result.action).toBe(ModerationAction.Mute);
    expect(api.mutedMembers).toEqual([["g1", "u1", 120]]);
  });

  it("removes members on kick rules", async () => {
    const result = await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "炸群内容"));
    expect(result.action).toBe(ModerationAction.Kick);
    expect(api.removedMembers).toEqual([["g1", "u1"]]);
  });

  it("queues review without immediate action", async () => {
    const result = await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "可疑内容"));
    expect(result.action).toBe(ModerationAction.Review);
    expect(result.executed).toBe(false);
    expect(result.detail).toBe("queued_for_review");
    expect(api.sentMessages).toEqual([]);
    expect(api.recalledMessages).toEqual([]);
    expect(auditLog.all()[0]?.status).toBe(AuditStatus.Pending);
  });

  it("skips disabled groups", async () => {
    configStore.setOverride({ groupId: "g1", enabled: false });
    const result = await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "广告"));
    expect(result.action).toBe(ModerationAction.Allow);
    expect(result.detail).toBe("disabled");
    expect(api.sentMessages).toEqual([]);
  });
});
