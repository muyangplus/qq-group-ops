import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AppealService } from "../src/services/appeals.js";
import { AppealWatcher } from "../src/services/appealWatcher.js";
import { AuditLogStore } from "../src/services/audit.js";
import { BlacklistService } from "../src/services/blacklist.js";
import { buildAppealGuideCard } from "../src/services/moderationCards.js";
import { ModerationNotifier } from "../src/services/moderationNotifier.js";
import { NotificationService, NOTIFY_SCOPE_ALL } from "../src/services/notifications.js";
import { PermissionService } from "../src/services/permissions.js";
import { PunishmentService } from "../src/services/punishments.js";

/**
 * §B7 处罚记录 + 卡片动作，§B8 申诉记录。
 */
function setup(
  options: {
    listBoundGroups?: () => string[];
    /** §B8 派发口径：管理员全部通知、审核员轮单。 */
    admins?: readonly string[];
    moderators?: readonly string[];
    appealHoldMs?: number;
    now?: () => number;
    /** 申诉短码随机源（默认全 0，便于断言；多条申诉的用例要传递增源避免撞码）。 */
    appealRandomInt?: (max: number) => number;
  } = {},
) {
  const api = new FakeQQOfficialAPI();
  const admins = options.admins ?? ["root"];
  const moderators = options.moderators ?? ["mod"];
  const permissions = new PermissionService({
    superAdminIds: new Set(admins),
    moderatorIds: new Map([["g1", new Set(moderators)]]),
  });
  const notifications = new NotificationService(api, permissions);
  for (const userId of [...admins, ...moderators]) {
    notifications.subscribe(userId, NOTIFY_SCOPE_ALL, "punish");
  }
  const blacklist = new BlacklistService(api, {
    auditLog: new AuditLogStore(),
    listBoundGroups: options.listBoundGroups ?? (() => ["g1"]),
  });
  const notifier = new ModerationNotifier({
    notifications,
    permissions,
    groupLabel: (groupId) => groupId,
    userLabel: (userId) => userId,
    ...(options.appealHoldMs !== undefined
      ? { appealHoldMs: options.appealHoldMs }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const punishments = new PunishmentService(api, blacklist, {
    notifier,
    randomInt: () => 0,
  });
  const appeals = new AppealService({
    ...(options.appealRandomInt !== undefined
      ? { randomInt: options.appealRandomInt }
      : { randomInt: () => 0 }),
  });
  return { api, permissions, notifications, blacklist, notifier, punishments, appeals };
}

/** 收到「申诉通知」卡的人（按发送顺序）。 */
function appealRecipients(api: FakeQQOfficialAPI): string[] {
  return api.sentPrivateMessages
    .filter((message) => String(message.markdown ?? "").includes("申诉通知"))
    .map((message) => String(message.userOpenid));
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
    // 没传 messageExcerpt（默认不保留原文）时卡片如实标注
    expect(String(card?.markdown)).toContain("**原文**：（未保留原文）");
    expect(punishments.get("#000000")?.detail).toBe("recall+mute+warn");
  });

  it("carries the original message on every private card of the appeal flow", async () => {
    const { api, appeals, notifier, punishments } = setup();
    const kept = await punishments.create({
      groupId: "g1",
      userId: "u1",
      ruleReason: "广告",
      messageExcerpt: "快来买广告",
      actions: {
        recalled: false,
        muted: false,
        muteDurationSeconds: 0,
        kicked: false,
        blacklist: "",
      },
    });
    await punishments.markExecuted(kept.recordId, "warn");
    const push = api.sentPrivateMessages
      .filter((item) => item.userOpenid === "mod")
      .at(-1);
    // §B7：原文是「标签 + 引用段落」，且必须在标题下第一段；
    // 引用块后面要有空行，否则后面的字段会被 Markdown 当成引用延续（真机踩过）
    expect(String(push?.markdown)).toContain("**原文**：\n> 快来买广告\n\n**群**：");
    expect(String(push?.markdown).indexOf("**原文**：")).toBeLessThan(
      String(push?.markdown).indexOf("**群**："),
    );

    const submitted = await appeals.submit({
      punishment: kept,
      userId: "u1",
      reason: "误判",
    });
    const notice = notifier.appealCard(submitted.appeal, kept, "mod");
    expect(String(notice.markdown)).toContain("**原文**：\n> 快来买广告\n\n**群**：");
    expect(notice.keyboard).toBeDefined();
    // §卡片规范 v2：不再写「通过申诉 = 解除处罚…」这类解释句
    expect(String(notice.markdown)).not.toContain("通过申诉");

    const guide = notifier.appealGuide(kept, "u1");
    expect(String(guide.markdown)).toContain("**原文**：\n> 快来买广告\n\n**处罚记录**：");
    expect(guide.keyboard).toBeDefined();
    // 主按钮是回调（被禁言也能点），另有预填指令的「写理由提交」
    expect(JSON.stringify(guide.keyboard)).toContain("cb:appeal:submit");
    expect(JSON.stringify(guide.keyboard)).toContain("写理由提交");
    const guideButtons = (guide.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    // §B8 真机反馈：「写理由提交」必须只填入输入框（`enter: false`），
    // 否则客户端会把命令直接发出去，用户根本没机会补理由
    expect(
      guideButtons.find((button) => button.label === "写理由提交")?.action,
    ).toMatchObject({ type: 2, enter: false });
    expect(
      guideButtons.find((button) => button.label === "直接提交")?.action,
    ).toMatchObject({ type: 1 });
    // 1:1 私信卡片不带 permission.specifyUserIds（真机出现「无权限操作」）
    expect(JSON.stringify(guide.keyboard)).not.toContain("specifyUserIds");
    // 有按钮时不再重复写用法文字
    expect(String(guide.markdown)).not.toContain("/appeal");

    const receipt = notifier.appealReceipt(submitted.appeal, kept, false);
    expect(String(receipt.markdown)).toContain("**原文**：\n> 快来买广告\n\n**处罚记录**：");
    expect(receipt.keyboard).toBeDefined();
    expect(JSON.stringify(receipt.keyboard)).not.toContain("specifyUserIds");
    // 当事人卡片不再出现审核员专属的「查看处罚」
    expect(JSON.stringify(receipt.keyboard)).not.toContain("cb:punish:view");
    expect(JSON.stringify(guide.keyboard)).not.toContain("cb:punish:view");

    // 键盘不可用时（老客户端 / 平台拒绝）引导卡必须给出可复制的等价指令
    const fallback = buildAppealGuideCard({
      recordId: kept.recordId,
      groupLabel: "g1",
      messageExcerpt: "快来买广告",
      recipientId: "u1",
      withButtons: false,
    });
    expect(fallback.keyboard).toBeUndefined();
    expect(String(fallback.markdown)).toContain(`/appeal #${kept.recordId}`);
  });

  it("notifies every admin but only one moderator, then rotates on timeout", async () => {
    let clock = 1_000;
    let appealSeed = 0;
    const { api, appeals, notifier, punishments } = setup({
      admins: ["root"],
      moderators: ["mod", "mod2"],
      appealHoldMs: 60_000,
      now: () => clock,
      appealRandomInt: () => appealSeed++,
    });
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      ruleReason: "广告",
      actions: {
        recalled: false,
        muted: true,
        muteDurationSeconds: 600,
        kicked: false,
        blacklist: "",
      },
    });

    // 第一条：管理员全通知（root）+ 轮到的审核员（mod）
    const first = await appeals.submit({ punishment: record, userId: "u1", reason: "一" });
    await notifier.notifyAppeal(first.appeal, record);
    expect(appealRecipients(api)).toEqual(["root", "mod"]);
    expect(notifier.appealHolder(first.appeal.appealId)).toBe("mod");

    // 第二条：群内游标前进，轮到 mod2（mod 不再收到）
    const second = await appeals.submit({ punishment: record, userId: "u2", reason: "二" });
    await notifier.notifyAppeal(second.appeal, record);
    expect(appealRecipients(api).slice(2)).toEqual(["root", "mod2"]);

    // 未到持有时间：不转派
    clock += 59_000;
    expect(await notifier.forwardAppealIfStale(first.appeal, record)).toBe(false);

    // 超过持有时间：转给下一位审核员
    clock += 2_000;
    expect(await notifier.forwardAppealIfStale(first.appeal, record)).toBe(true);
    expect(notifier.appealHolder(first.appeal.appealId)).toBe("mod2");

    // 审核员轮完一圈：不再无限转派
    clock += 61_000;
    expect(await notifier.forwardAppealIfStale(first.appeal, record)).toBe(false);
  });

  it("syncs the decision to other reviewers and skips the handler", async () => {
    const { api, appeals, notifier, punishments } = setup({
      admins: ["root"],
      moderators: ["mod"],
    });
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: false,
        muted: true,
        muteDurationSeconds: 600,
        kicked: false,
        blacklist: "",
      },
    });
    const submitted = await appeals.submit({
      punishment: record,
      userId: "u1",
      reason: "误判",
    });
    await notifier.notifyAppeal(submitted.appeal, record);
    api.sentPrivateMessages.length = 0;

    await notifier.notifyAppealHandled(submitted.appeal, record, true, "mod");
    const notice = api.sentPrivateMessages.find(
      (message) => String(message.markdown ?? "").includes("申诉已处理"),
    );
    expect(notice?.userOpenid).toBe("root");
    expect(String(notice?.markdown)).toContain("已通过");
    // 处理人自己不再收同步卡
    expect(
      api.sentPrivateMessages.some((message) => message.userOpenid === "mod"),
    ).toBe(false);
    // 值班记录释放，不会内存泄漏
    expect(notifier.appealHolder(submitted.appeal.appealId)).toBeUndefined();
  });

  it("forwards a stale appeal to the next moderator through AppealWatcher", async () => {
    let clock = 1_000;
    let appealSeed = 0;
    const { api, appeals, notifier, punishments } = setup({
      admins: [],
      moderators: ["mod", "mod2"],
      appealHoldMs: 60_000,
      now: () => clock,
      appealRandomInt: () => appealSeed++,
    });
    const record = await punishments.create({
      groupId: "g1",
      userId: "u1",
      actions: {
        recalled: false,
        muted: true,
        muteDurationSeconds: 600,
        kicked: false,
        blacklist: "",
      },
    });
    const submitted = await appeals.submit({
      punishment: record,
      userId: "u1",
      reason: "误判",
    });
    // 没有管理员订阅时，第一位审核员也会收到（否则没人处理）
    await notifier.notifyAppeal(submitted.appeal, record);
    expect(appealRecipients(api)).toEqual(["mod"]);
    api.sentPrivateMessages.length = 0;

    const watcher = new AppealWatcher(notifier, appeals, punishments, {
      intervalMs: 0,
    });
    expect(await watcher.runOnce()).toBe(0);
    clock += 61_000;
    expect(await watcher.runOnce()).toBe(1);
    expect(appealRecipients(api)).toEqual(["mod2"]);

    // 处理掉之后不再转派
    await appeals.decide({
      code: submitted.appeal.appealId,
      reviewerId: "mod2",
      status: "rejected",
      note: "已驳回",
    });
    clock += 61_000;
    expect(await watcher.runOnce()).toBe(0);
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
