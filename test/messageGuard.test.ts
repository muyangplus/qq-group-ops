import { describe, expect, it, beforeEach, vi } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AuditStatus, KeywordPunish, ModerationAction } from "../src/core/enums.js";
import { newIncomingMessage } from "../src/core/models.js";
import { AuditLogStore } from "../src/services/audit.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { MessageGuardService } from "../src/services/messageGuard.js";
import { RuleEngine } from "../src/services/moderation.js";
import { PermissionService } from "../src/services/permissions.js";
import { RichMessageSender } from "../src/services/richMessages.js";

describe("MessageGuardService", () => {
  let api: FakeQQOfficialAPI;
  let auditLog: AuditLogStore;
  let configStore: GroupConfigStore;
  let service: MessageGuardService;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    auditLog = new AuditLogStore();
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

  it("exempts moderators and above from keyword checks", async () => {
    const permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      moderatorIds: new Map([["g1", new Set(["mod"])]]),
    });
    const rules = new RuleEngine([
      { ruleId: "warn", pattern: "广告", action: ModerationAction.Warn },
    ]);
    const scoped = new MessageGuardService(
      api,
      rules,
      configStore,
      auditLog,
      permissions,
    );

    const moderator = await scoped.handleMessage(
      newIncomingMessage("g1", "mod", "m1", "这是广告"),
    );
    expect(moderator.action).toBe(ModerationAction.Allow);
    expect(moderator.detail).toBe("exempt");
    expect(api.sentMessages).toEqual([]);
    expect(auditLog.all()).toEqual([]);

    // 普通成员仍然会被警告
    const member = await scoped.handleMessage(
      newIncomingMessage("g1", "member", "m2", "这是广告"),
    );
    expect(member.action).toBe(ModerationAction.Warn);
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

describe("MessageGuardService keyword rules", () => {
  let api: FakeQQOfficialAPI;
  let auditLog: AuditLogStore;
  let configStore: GroupConfigStore;
  let service: MessageGuardService;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    auditLog = new AuditLogStore();
    configStore = new GroupConfigStore({ groupId: "__default__" });
    // 静态规则为空，验证审核能力完全来自群配置关键词
    service = new MessageGuardService(api, new RuleEngine(), configStore, auditLog);
  });

  it("uses group keywords to warn and audits the match", async () => {
    configStore.setOverride({ groupId: "g1", keywords: ["广告"] });

    const result = await service.handleMessage(
      newIncomingMessage("g1", "u1", "m1", "这是广告内容"),
    );

    expect(result.action).toBe(ModerationAction.Warn);
    expect(result.executed).toBe(true);
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0]?.content).toContain("请遵守群规");
    expect(auditLog.all()[0]?.reason).toBe("命中关键词：广告");
  });

  it("uses the group warning message", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      warningMessage: "本群禁止广告，请撤回。",
    });

    await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "广告"));

    expect(api.sentMessages[0]?.content).toBe("本群禁止广告，请撤回。");
  });

  it("keeps keywords per group", async () => {
    configStore.setOverride({ groupId: "g1", keywords: ["广告"] });

    const other = await service.handleMessage(
      newIncomingMessage("g2", "u1", "m2", "广告"),
    );

    expect(other.action).toBe(ModerationAction.Allow);
    expect(other.detail).toBe("no_match");
    expect(api.sentMessages).toEqual([]);
  });

  it("picks up keyword changes without restarting", async () => {
    const before = await service.handleMessage(
      newIncomingMessage("g1", "u1", "m1", "刷屏"),
    );
    expect(before.action).toBe(ModerationAction.Allow);

    configStore.setOverride({ groupId: "g1", keywords: ["刷屏"] });
    const after = await service.handleMessage(
      newIncomingMessage("g1", "u2", "m2", "刷屏"),
    );
    expect(after.action).toBe(ModerationAction.Warn);
  });

  it("skips groups with the word filter disabled", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      wordFilterEnabled: false,
    });

    const result = await service.handleMessage(
      newIncomingMessage("g1", "u1", "m1", "广告"),
    );

    expect(result.action).toBe(ModerationAction.Allow);
    expect(result.detail).toBe("disabled");
  });

  it("recalls and punishes when the group config asks for it", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      keywordRecall: true,
      keywordPunish: KeywordPunish.Mute,
      muteDurationSeconds: 120,
    });

    const result = await service.handleMessage(
      newIncomingMessage("g1", "u1", "m1", "广告内容"),
    );

    expect(api.recalledMessages).toEqual([["g1", "m1"]]);
    expect(api.mutedMembers).toEqual([["g1", "u1", 120]]);
    expect(api.sentMessages).toHaveLength(1);
    expect(result.executed).toBe(true);
    expect(result.detail).toContain("recall");
    expect(result.detail).toContain("mute");
    expect(result.detail).toContain("warn");
  });

  it("supports kick and kick plus blacklist", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      keywordPunish: KeywordPunish.Kick,
    });
    await service.handleMessage(newIncomingMessage("g1", "u1", "m1", "广告"));
    expect(api.removedMembers).toEqual([["g1", "u1"]]);
    expect(api.blacklistOperations).toEqual([]);

    configStore.setOverride({
      groupId: "g1",
      keywordPunish: KeywordPunish.KickBlacklist,
    });
    await service.handleMessage(newIncomingMessage("g1", "u2", "m2", "广告"));
    expect(api.removedMembers).toEqual([
      ["g1", "u1"],
      ["g1", "u2"],
    ]);
    expect(api.blacklistOperations).toEqual([["g1", "u2", "add"]]);
  });

  it("keeps applying other actions when one of them fails", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      keywordRecall: true,
      keywordPunish: KeywordPunish.Mute,
    });
    vi.spyOn(api, "recallGroupMessage").mockRejectedValue(
      new Error("recall not allowed"),
    );

    const result = await service.handleMessage(
      newIncomingMessage("g1", "u1", "m1", "广告"),
    );

    expect(result.detail).toContain("recall_failed");
    expect(result.detail).toContain("mute");
    // 撤回失败但禁言成功，仍算已执行
    expect(result.executed).toBe(true);
    expect(api.mutedMembers).toEqual([["g1", "u1", 600]]);
  });

  it("marks the audit record pending when every action fails", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      keywordPunish: KeywordPunish.Kick,
    });
    vi.spyOn(api, "removeGroupMember").mockRejectedValue(
      new Error("11253 应用无接口访问权限"),
    );
    vi.spyOn(api, "sendGroupMessage").mockRejectedValue(new Error("no quota"));

    const result = await service.handleMessage(
      newIncomingMessage("g1", "u1", "m1", "广告"),
    );

    expect(result.executed).toBe(false);
    expect(auditLog.all()[0]?.status).toBe(AuditStatus.Pending);
  });

  /** B2：注入富消息发送器时，命中反馈是一张「@ 当事人 + 命中规则 + 处理动作」的完整卡片。 */
  it("sends a complete card that mentions the offender", async () => {
    const rules = new RuleEngine([
      { ruleId: "warn", pattern: "广告", action: ModerationAction.Warn, reason: "发现广告" },
      { ruleId: "mute", pattern: "刷屏", action: ModerationAction.Mute, reason: "发现刷屏" },
    ]);
    configStore.setOverride({ groupId: "g1", muteDurationSeconds: 300 });
    const scoped = new MessageGuardService(
      api,
      rules,
      configStore,
      auditLog,
      undefined,
      new RichMessageSender(api),
    );

    // 仅警告：卡片含 @、命中规则与处理动作，且仍是被动回复原消息
    const warned = await scoped.handleMessage(
      newIncomingMessage("g1", "u1", "m1", "这是广告"),
    );
    expect(warned.executed, `warn detail=${warned.detail}`).toBe(true);
    const warnCard = api.sentMessages.at(-1);
    expect(warnCard?.msgId).toBe("m1");
    const warnText = String(warnCard?.markdown ?? "");
    expect(warnText).toContain("<@!u1>");
    expect(warnText).toContain("命中规则");
    expect(warnText).toContain("发现广告");
    expect(warnText).toContain("仅警告");

    // 禁言：处理动作写明时长
    const muted = await scoped.handleMessage(
      newIncomingMessage("g1", "u1", "m2", "一直刷屏"),
    );
    expect(muted.executed, `mute detail=${muted.detail}`).toBe(true);
    const muteText = String(api.sentMessages.at(-1)?.markdown ?? "");
    expect(muteText).toContain("<@!u1>");
    expect(muteText).toContain("禁言 300 秒");
    expect(api.mutedMembers).toEqual([["g1", "u1", 300]]);
  });
});
