import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AppealService } from "../src/services/appeals.js";
import { AuditLogStore } from "../src/services/audit.js";
import { BlacklistService } from "../src/services/blacklist.js";
import { ModerationNotifier } from "../src/services/moderationNotifier.js";
import { NotificationService, NOTIFY_SCOPE_ALL } from "../src/services/notifications.js";
import { PermissionService } from "../src/services/permissions.js";
import { PunishmentService } from "../src/services/punishments.js";

/**
 * §B7 处罚记录 + 卡片动作，§B8 申诉记录。
 */
function setup(options: { listBoundGroups?: () => string[] } = {}) {
  const api = new FakeQQOfficialAPI();
  const permissions = new PermissionService({
    superAdminIds: new Set(["root"]),
    moderatorIds: new Map([["g1", new Set(["mod"])]]),
  });
  const notifications = new NotificationService(api, permissions);
  notifications.subscribe("mod", NOTIFY_SCOPE_ALL, "punish");
  const blacklist = new BlacklistService(api, {
    auditLog: new AuditLogStore(),
    listBoundGroups: options.listBoundGroups ?? (() => ["g1"]),
  });
  const notifier = new ModerationNotifier({
    notifications,
    permissions,
    groupLabel: (groupId) => groupId,
    userLabel: (userId) => userId,
  });
  const punishments = new PunishmentService(api, blacklist, {
    notifier,
    randomInt: () => 0,
  });
  const appeals = new AppealService({ randomInt: () => 0 });
  return { api, permissions, notifications, blacklist, notifier, punishments, appeals };
}

describe("PunishmentService", () => {
  it("records a punishment and pushes a card to punish subscribers", async () => {
    const { api, punishments } = setup();
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      ruleReason: "广告",
      messageId: "m1",
      actions: {
        recalled: true,
        muted: true,
        muteDurationSeconds: 600,
        kicked: false,
        blacklist: "",
      },
    });
    expect(record.recordId).toBe("000000");

    await punishments.markExecuted(record.recordId, "recall+mute+warn");

    const card = api.sentPrivateMessages.find((item) => item.userOpenid === "mod");
    expect(card).toBeDefined();
    expect(String(card?.markdown)).toContain("处罚通知");
    expect(String(card?.markdown)).toContain("#000000");
    expect(String(card?.markdown)).toContain("禁言 10 分钟");
    expect(punishments.get("#000000")?.detail).toBe("recall+mute+warn");
  });

  it("does not push the same punishment twice", async () => {
    const { api, punishments } = setup();
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: false,
        muted: true,
        muteDurationSeconds: 60,
        kicked: false,
        blacklist: "",
      },
    });
    await punishments.markExecuted(record.recordId, "mute");
    await punishments.markExecuted(record.recordId, "mute");

    expect(
      api.sentPrivateMessages.filter((item) => item.userOpenid === "mod"),
    ).toHaveLength(1);
  });

  it("release undoes a mute and a group blacklist entry", async () => {
    const { api, blacklist, punishments } = setup();
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: true,
        muted: true,
        muteDurationSeconds: 600,
        kicked: true,
        blacklist: "group",
      },
    });
    await blacklist.add({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
    });
    // 模拟记录里已经拉黑
    await punishments.blacklistUser({ code: record.recordId, scope: "group", actorId: "mod" });

    const result = await punishments.release({
      code: record.recordId,
      actorId: "mod",
      note: "误判",
    });

    expect(result?.ok).toBe(true);
    expect(result?.text).toContain("解除禁言");
    // 解除禁言 = duration 0
    expect(api.mutedMembers).toContainEqual(["g1", "u1", 0]);
    expect(blacklist.has("g1", "u1")).toBe(false);
    expect(punishments.get(record.recordId)?.status).toBe("released");
    expect(punishments.get(record.recordId)?.actions.blacklist).toBe("");
  });

  it("setMute updates the mute duration and records it", async () => {
    const { api, punishments } = setup();
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: false,
        muted: true,
        muteDurationSeconds: 60,
        kicked: false,
        blacklist: "",
      },
    });

    const result = await punishments.setMute({
      code: record.recordId,
      seconds: 3600,
      actorId: "mod",
    });

    expect(result?.ok).toBe(true);
    expect(api.mutedMembers.at(-1)).toEqual(["g1", "u1", 3600]);
    expect(punishments.get(record.recordId)?.actions.muteDurationSeconds).toBe(3600);
  });

  it("kick removes the member and blacklist marks the record", async () => {
    const { api, blacklist, punishments } = setup();
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: false,
        muted: false,
        muteDurationSeconds: 0,
        kicked: false,
        blacklist: "",
      },
    });

    await punishments.kick({ code: record.recordId, actorId: "mod" });
    expect(api.removedMembers).toContainEqual(["g1", "u1"]);

    await punishments.blacklistUser({
      code: record.recordId,
      scope: "global",
      actorId: "root",
      reason: "跨群骚扰",
    });
    expect(blacklist.hasGlobal("u1")).toBe(true);
    expect(punishments.get(record.recordId)?.actions.blacklist).toBe("global");
  });
});

describe("AppealService", () => {
  it("keeps one pending appeal per punishment and updates the reason", async () => {
    const { punishments, appeals } = setup();
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: false,
        muted: true,
        muteDurationSeconds: 60,
        kicked: false,
        blacklist: "",
      },
    });

    const first = await appeals.submit({ punishment: record, userId: "u1", reason: "" });
    expect(first.updated).toBe(false);
    const second = await appeals.submit({
      punishment: record,
      userId: "u1",
      reason: "我没发广告",
    });
    expect(second.updated).toBe(true);
    expect(second.appeal.reason).toBe("我没发广告");
    expect(appeals.pendingByPunishment(record.recordId)).toHaveLength(1);
  });

  it("marks pending appeals accepted when a reviewer adjusts the punishment", async () => {
    const { punishments, appeals } = setup();
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: false,
        muted: true,
        muteDurationSeconds: 60,
        kicked: false,
        blacklist: "",
      },
    });
    const { appeal } = await appeals.submit({
      punishment: record,
      userId: "u1",
      reason: "误判",
    });

    const decided = await appeals.acceptByPunishment({
      punishmentId: record.recordId,
      reviewerId: "mod",
      note: "已调整禁言时长",
    });

    expect(decided).toHaveLength(1);
    expect(appeals.get(appeal.appealId)?.status).toBe("accepted");
    expect(appeals.get(appeal.appealId)?.note).toBe("已调整禁言时长");
  });
});
