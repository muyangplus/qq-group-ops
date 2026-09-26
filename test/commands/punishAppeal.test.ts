import { describe, expect, it } from "vitest";

import { KeywordPunish } from "../../src/core/enums.js";
import { newIncomingMessage } from "../../src/core/models.js";
import {
  MessageGuardService,
  RAW_MESSAGE_EXCERPT_MAX,
} from "../../src/services/messageGuard.js";
import { RuleEngine } from "../../src/services/moderation.js";
import { RichMessageSender } from "../../src/services/richMessages.js";
import {
  api,
  appeals,
  blacklist,
  configStore,
  notifications,
  privateText,
  punishments,
  service,
} from "../helpers/adminCommandsHarness.js";

/**
 * §A5 / §B7 / §B8 的指令与卡片路径（共享夹具）。
 */
function createPunishment(userId: string, messageExcerpt = "") {
  return punishments.create({
    groupId: "g1",
    userId,
    ruleReason: "广告",
    messageId: "m1",
    ...(messageExcerpt.length > 0 ? { messageExcerpt } : {}),
    actions: {
      recalled: true,
      muted: true,
      muteDurationSeconds: 600,
      kicked: false,
      blacklist: "",
    },
  });
}

describe("AdminCommandService · blacklist / punish / appeal", () => {
  it("lets moderators manage the group blacklist but not the global one", async () => {
    const denied = await service.handle("g1", "member", "/blacklist");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");

    const added = await service.handle("g1", "mod", "/blacklist add u3 广告");
    expect(added.ok).toBe(true);
    expect(added.text).toContain("10005");
    expect(blacklist.has("g1", "u3")).toBe(true);
    expect(api.removedMembers).toContainEqual(["g1", "u3"]);

    const globalDenied = await service.handle("g1", "mod", "/blacklist add 全局 u3");
    expect(globalDenied.ok).toBe(false);
    expect(globalDenied.text).toContain("仅超级管理员");

    const globalAdded = await service.handle("g1", "root", "/blacklist add 全局 u3 跨群骚扰");
    expect(globalAdded.ok).toBe(true);
    expect(blacklist.hasGlobal("u3")).toBe(true);

    const removed = await service.handle("g1", "mod", "/blacklist del u3");
    expect(removed.ok).toBe(true);
    // 本群条目已删除；全局条目仍在（全局命中优先）
    expect(blacklist.hasGroup("g1", "u3")).toBe(false);
    expect(blacklist.has("g1", "u3")).toBe(true);
    const removedGlobal = await service.handle("g1", "root", "/blacklist del u3 全局");
    expect(removedGlobal.ok).toBe(true);
    expect(blacklist.has("g1", "u3")).toBe(false);
  });

  it("shows the punish record list and denies members", async () => {
    const record = await createPunishment("member", "快来买广告");

    const denied = await service.handle("g1", "member", "/punish list");
    expect(denied.ok).toBe(false);

    const listed = await service.handle("g1", "mod", "/punish list");
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain(`#${record.recordId}`);
    expect(listed.text).toContain("10001");

    const detail = await service.handle("g1", "mod", `/punish #${record.recordId}`);
    expect(detail.ok).toBe(true);
    expect(detail.text).toContain("广告");
    // 原文只渲染一次（标题下第一段的引用段落），且后面的字段没被吞进引用
    expect(String(detail.rich?.markdown).match(/原文/gu) ?? []).toHaveLength(1);
    expect(String(detail.rich?.markdown)).toContain(
      "**原文**：\n> 快来买广告\n\n**群**：",
    );
  });

  it("submits an appeal, notifies subscribers and lets them release the punishment", async () => {
    notifications.subscribe("mod", "__all__", "punish");
    const record = await createPunishment("member");

    const submitted = await service.handle("g1", "member", `/appeal #${record.recordId} 我没发广告`);
    expect(submitted.ok).toBe(true);
    // 群内静默：结果只私信
    expect(submitted.silent).toBe(true);
    const receipt = api.sentPrivateMessages.find((item) => item.userOpenid === "member");
    expect(String(receipt?.markdown ?? receipt?.content)).toContain("申诉");
    const reviewerCard = api.sentPrivateMessages.find((item) => item.userOpenid === "mod");
    expect(String(reviewerCard?.markdown)).toContain("申诉通知");

    const appeal = appeals.pendingByPunishment(record.recordId)[0]!;
    const accepted = await service.appealCallbackCard("accept", [appeal.appealId], "mod");
    expect(accepted?.text).toContain("申诉已通过");
    expect(api.mutedMembers).toContainEqual(["g1", "member", 0]);
    expect(punishments.get(record.recordId)?.status).toBe("released");
    expect(appeals.get(appeal.appealId)?.status).toBe("accepted");
  });

  it("lets reviewers adjust the mute duration from the card callbacks", async () => {
    const record = await createPunishment("member");

    const options = await service.punishCallbackCard("mute", [record.recordId], "mod");
    expect(options?.text).toContain("修改禁言时长");
    expect(options?.text).toContain("当前：禁言 10 分钟");
    expect(JSON.stringify(options?.rich.keyboard)).toContain("1小时");

    const updated = await service.punishCallbackCard(
      "setmute",
      [record.recordId, "3600"],
      "mod",
    );
    expect(updated?.text).toContain("已调整禁言时长");
    expect(api.mutedMembers.at(-1)).toEqual(["g1", "member", 3600]);
    expect(punishments.get(record.recordId)?.actions.muteDurationSeconds).toBe(3600);

    const denied = await service.punishCallbackCard("release", [record.recordId], "member");
    expect(denied?.text).toContain("权限不足");
  });

  it("auto-submits a reason-less appeal when the private guide cannot be delivered", async () => {
    const record = await createPunishment("member");
    // 沙箱 / 没私聊过机器人：任何私信都发不出去
    api.failPrivateMessages = true;
    try {
      const result = await service.appealCallbackCard("new", [record.recordId], "member");
      // 群里回一条不含申诉内容的提示
      expect(result?.ok).toBe(true);
      expect(result?.text).toContain("申诉已提交");
      expect(String(result?.rich?.markdown)).toContain("无理由");
      expect(String(result?.rich?.markdown)).toContain("<@!member>");
      // 申诉真的建了单，且理由为空
      const appeal = appeals.pendingByPunishment(record.recordId)[0];
      expect(appeal).toBeDefined();
      expect(appeal?.reason).toBe("");
    } finally {
      api.failPrivateMessages = false;
    }
  });

  it("stores the triggering message only when message retention is on", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      punishActions: { warn: true, recall: false, mute: true, kick: false, blacklist: false },
      wordFilterEnabled: true,
    });
    const buildGuard = (): MessageGuardService =>
      new MessageGuardService(
        api,
        new RuleEngine(),
        configStore,
        undefined,
        undefined,
        new RichMessageSender(api),
        punishments,
      );

    // 默认 rawMessageRetentionDays = 0：不落库
    await buildGuard().handleMessage(
      newIncomingMessage("g1", "member", "m1", "这是广告 快来买"),
    );
    expect(punishments.listForUser("g1", "member")[0]?.messageExcerpt).toBe("");

    // 开启 7 天后：落库原文（压成单行 + 截断）
    configStore.setOverride({ groupId: "g1", rawMessageRetentionDays: 7 });
    await buildGuard().handleMessage(
      newIncomingMessage("g1", "member", "m2", `这是广告\n${"长".repeat(300)}`),
    );
    const record = punishments.listForUser("g1", "member")[0]!;
    expect(record.messageExcerpt.startsWith("这是广告 ")).toBe(true);
    expect(record.messageExcerpt).not.toContain("\n");
    expect(record.messageExcerpt).toHaveLength(RAW_MESSAGE_EXCERPT_MAX);
  });

  it("submits a reason-less appeal from the private card callback (muted-safe)", async () => {
    const record = await createPunishment("member");

    // 回调「直接提交」：不经过客户端发送，被禁言也能用
    const receipt = await service.appealCallbackCard("submit", [record.recordId], "member");
    expect(receipt?.ok).toBe(true);
    expect(receipt?.text).toContain("申诉已提交");
    expect(JSON.stringify(receipt?.rich?.keyboard)).toContain("补充理由");
    const appeal = appeals.pendingByPunishment(record.recordId)[0];
    expect(appeal?.reason).toBe("");

    // 别人的处罚不能替人申诉（不产生任何卡片）
    const other = await createPunishment("other");
    const denied = await service.appealCallbackCard("submit", [other.recordId], "member");
    expect(denied).toBeUndefined();
  });

  it("blocks repeat submissions while an appeal is pending", async () => {
    const record = await createPunishment("member");

    const first = await service.handle("g1", "member", `/appeal #${record.recordId} 误判`);
    expect(first.ok).toBe(true);

    // 再提交：被拦下（否则被处罚人可以反复刷单骚扰审核员）
    const again = await service.handle("g1", "member", `/appeal #${record.recordId} 再申一次`);
    expect(again.ok).toBe(false);
    expect(privateText("member")).toContain("已有待处理申诉");

    // 私信卡片的「直接提交」按钮同样被拦
    const viaButton = await service.appealCallbackCard("submit", [record.recordId], "member");
    expect(viaButton?.ok).toBe(false);
    expect(viaButton?.text).toContain("已有待处理");

    // 群内「我要申诉」也不再重复发引导卡
    await service.appealCallbackCard("new", [record.recordId], "member");
    expect(privateText("member")).toContain("已有待处理申诉");

    // 全程只有一条待处理申诉，理由没被覆盖
    const pending = appeals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reason).toBe("误判");
  });

  it("notifies the appellant when the appeal is decided", async () => {
    notifications.subscribe("mod", "__all__", "punish");
    const record = await createPunishment("member");
    await service.handle("g1", "member", `/appeal #${record.recordId} 误判`);
    const appeal = appeals.pendingByPunishment(record.recordId)[0]!;

    // 驳回 → 申诉人自己收到结果
    await service.appealCallbackCard("reject", [appeal.appealId], "mod");
    expect(privateText("member")).toContain("申诉已驳回");
    expect(privateText("member")).toContain("驳回");
  });

  it("adds an appeal button to the keyword warning card and records the punishment", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      punishActions: { warn: true, recall: false, mute: true, kick: false, blacklist: false },
      wordFilterEnabled: true,
    });
    const guard = new MessageGuardService(
      api,
      new RuleEngine(),
      configStore,
      undefined,
      undefined,
      new RichMessageSender(api),
      punishments,
    );

    const result = await guard.handleMessage(
      newIncomingMessage("g1", "member", "m1", "这是广告"),
    );

    // 规则本身是「警告」，群配置额外要求禁言，因此 action 仍是 warn
    expect(result.action).toBe("warn");
    const warning = api.sentMessages.at(-1);
    expect(String(warning?.markdown)).toContain("处罚通知");
    expect(String(warning?.markdown)).not.toContain("命中规则");
    expect(JSON.stringify(warning?.keyboard)).toContain("appeal");
    const record = punishments.listForUser("g1", "member")[0]!;
    expect(record.actions.muted).toBe(true);
    expect(record.actions.muteDurationSeconds).toBe(configStore.get("g1").muteDurationSeconds);
    // §B8：被禁言时群里按钮点不动，所以群里那张卡必须给出私聊申诉的等价指令
    expect(String(warning?.markdown)).toContain(`/appeal #${record.recordId} <理由>`);
    expect(String(warning?.markdown)).toContain("点击下方按钮或私聊机器人发送");
  });
});
