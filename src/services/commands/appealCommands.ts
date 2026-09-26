import { renderCard, escapeCardText } from "../cardTemplate.js";
import type { RichMessage } from "../richMessages.js";
import type { AppealRecord } from "../../db/appealRepository.js";
import type { PunishmentRecord } from "../../db/punishmentRepository.js";
import { getLogger } from "../../core/logger.js";
import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  formatTime,
  normalize,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

/**
 * `/appeal` 领域模块（§B8）。
 *
 * - 当事人用 `/appeal #处罚短码 [理由]` 提交申诉（也可点群内警告卡上的「我要申诉」按钮）；
 * - 机器人把申诉私信推送给「处罚通知」的订阅者（审核员及以上）；
 * - 审核员在私信卡片上**直接调整处罚**（`cb:punish:*`）或通过 / 驳回申诉。
 *
 * 群内提交是**静默**的：结果只走私信，不在群里回「已申诉」。
 */
export const APPEAL_USAGE = [
  "用法：",
  "  /appeal <#处罚短码> [理由]   对某条处罚提交申诉（只能申诉自己的处罚）",
  "  /appeal list                 查看我提交过的申诉",
].join("\n");

const log = getLogger("appeal-commands");

/**
 * 已有待处理申诉时的提示卡（回给当事人本人）。
 *
 * §B8 真机反馈：允许无限次提交会骚扰审核员；只要还有待处理申诉，就不接受重复提交 / 补充理由，
 * 等到审核员处理（通过 / 驳回）后才能再提交。
 */
function duplicateAppealCard(pending: AppealRecord): RichMessage {
  return renderCard({
    title: "已有待处理申诉",
    lines: [
      `**申诉**：#${pending.appealId}`,
      `**处罚记录**：#${pending.punishmentId}`,
      `**已提交理由**：${pending.reason.length > 0 ? escapeCardText(pending.reason) : "（未填写）"}`,
      "",
      "审核员还没处理，处理结果会私信通知你；在那之前不能重复提交或补充理由。",
    ],
  });
}

/**
 * 申诉出结果后的收尾（§B8）：
 *
 * 1. **通知申诉人本人**（通过 / 驳回 + 处理人 + 备注）——真机反馈此前只有审核员知道结果；
 * 2. **同步给其他订阅者**，避免别人再重复处理。
 */
async function afterAppealDecided(
  ctx: AdminCommandContext,
  appeal: AppealRecord,
  punishment: PunishmentRecord | undefined,
  approved: boolean,
  reviewerId: string,
  note: string,
): Promise<void> {
  const notifier = ctx.moderationNotifier;
  if (!notifier || !punishment) {
    return;
  }
  const sent = await notifier.notifyAppealDecision(
    appeal,
    punishment,
    approved,
    reviewerId,
    note,
  );
  if (!sent.ok) {
    log.warn("appeal decision notify failed", {
      appealId: appeal.appealId,
      userId: appeal.userId,
      error: sent.detail,
    });
  }
  await notifier.notifyAppealHandled(appeal, punishment, approved, reviewerId);
}

/**
 * 建一条**无理由**申诉并通知审核员（§B8 降级路径与「直接提交」按钮共用）。
 *
 * `replyInGroup` = 私信引导卡发不出去时为 true：此时只能在群里回一条**不含申诉内容**的提示，
 * 让当事人知道申诉没有丢。回调「直接提交」发生在私信里，`replyInGroup` = false。
 */
async function submitReasonlessAppeal(
  ctx: AdminCommandContext,
  record: PunishmentRecord,
  userId: string,
  replyInGroup: boolean,
): Promise<CardResult> {
  const appeals = ctx.appeals!;
  const notifier = ctx.moderationNotifier!;
  const result = await appeals.submit({
    punishment: record,
    userId,
    reason: "",
  });
  if (!result.updated) {
    await notifier.notifyAppeal(result.appeal, record);
  }
  log.info("reason-less appeal submitted", {
    punishmentId: record.recordId,
    appealId: result.appeal.appealId,
    updated: result.updated,
    replyInGroup,
  });
  if (!replyInGroup) {
    // 私信里的「直接提交」：回执本身就是回复，还能点「补充理由」
    const receipt = notifier.appealReceipt(result.appeal, record, result.updated);
    return { ok: true, text: receipt.text, rich: receipt };
  }
  const card = renderCard({
    title: "申诉已提交",
    lines: [
      `<@!${userId}>`,
      "私信暂时发不出去，已按**无理由**提交申诉，审核员会处理。",
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

export async function handleAppeal(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const appeals = ctx.appeals;
  const punishments = ctx.punishments;
  const notifier = ctx.moderationNotifier;
  if (!appeals || !punishments || !notifier) {
    return { ok: false, text: "申诉服务未启用。" };
  }
  const action = normalize(parts[1]);
  if (!action) {
    return { ok: false, text: APPEAL_USAGE };
  }
  if (action === "list" || action === "列表") {
    return appealListCard(ctx, userId, groupId);
  }

  const record = punishments.get(parts[1]);
  if (!record) {
    return { ok: false, text: `未找到处罚记录：${parts[1]}\n\n${APPEAL_USAGE}` };
  }
  if (record.userId !== userId) {
    return { ok: false, text: "只能对自己的处罚提交申诉。" };
  }
  // §B8：只要还有待处理申诉，就不接受重复提交 / 补充理由（避免刷单骚扰审核员）；
  // 审核员处理（通过 / 驳回）之后才能再提交。
  const pending = appeals.pendingFor(record.recordId, userId);
  if (pending) {
    const card = duplicateAppealCard(pending);
    const sent = await notifier.notifyAppellant(userId, card);
    return {
      ok: false,
      text: sent.ok ? "结果已私信发送。" : card.text,
      rich: card,
      ...(groupId !== undefined ? { silent: true } : {}),
    };
  }
  const reason = parts.slice(2).join(" ");
  const result = await appeals.submit({ punishment: record, userId, reason });
  const receipt = notifier.appealReceipt(result.appeal, record, result.updated);
  await notifier.notifyAppellant(userId, receipt);
  if (!result.updated) {
    await notifier.notifyAppeal(result.appeal, record);
  }
  return {
    ok: true,
    text: result.updated ? "申诉理由已更新，已私信给你回执。" : "申诉已提交，已私信给你回执。",
    rich: receipt,
    // 群内静默：申诉是隐私动作，只走私信
    ...(groupId !== undefined ? { silent: true } : {}),
  };
}

/** 我的申诉列表卡。 */
export function appealListCard(
  ctx: AdminCommandContext,
  userId: string,
  groupId?: string,
): CardResult {
  const appeals = ctx.appeals;
  if (!appeals) {
    return cardFromText("我的申诉", "申诉服务未启用。");
  }
  const records = appeals
    .listForUser(userId, Number.MAX_SAFE_INTEGER)
    .filter((appeal) => groupId === undefined || appeal.groupId === groupId);
  const statusLabel = (status: string): string =>
    status === "pending" ? "待处理" : status === "accepted" ? "已通过" : "已驳回";
  const lines = [`**申诉数**：${records.length}`];
  if (records.length === 0) {
    lines.push("", "（暂无申诉）");
  } else {
    lines.push("");
    records.slice(0, 10).forEach((appeal, index) => {
      lines.push(
        `${index + 1}. #${appeal.appealId}（处罚 #${appeal.punishmentId}）` +
          ` — ${statusLabel(appeal.status)}` +
          ` @ ${formatTime(appeal.createdAt)}`,
      );
      if (appeal.note) {
        lines.push(`  处理备注：${appeal.note}`);
      }
    });
  }
  return cardFromText("我的申诉", lines.join("\n"), {
    rows: [
      [
        viewButton("help", "申诉帮助", "help", "topic", "appeal"),
      ],
    ],
    footer: [APPEAL_USAGE],
  });
}

/**
 * `cb:appeal:*` 回调入口。
 *
 * - `new`：群内处罚卡（或旧卡）的「我要申诉」按钮 → 只私信引导卡给当事人，**不在群里发任何消息**
 *   （返回 `undefined`，由 CallbackRouter 只回包）；私信发不出去时**降级为直接建单**；
 * - `submit`：私信引导卡上的「直接提交」（回调，一键建**无理由**单）——
 *   用回调而不是指令按钮，是因为被禁言的当事人点指令按钮会被 QQ 客户端拦住；
 * - `accept` / `reject`：审核员在申诉卡片上处理。
 */
export async function appealCallbackCard(
  ctx: AdminCommandContext,
  action: string,
  args: readonly string[],
  userId: string,
  replyGroupId?: string,
): Promise<CardResult | undefined> {
  const appeals = ctx.appeals;
  const punishments = ctx.punishments;
  const notifier = ctx.moderationNotifier;
  if (!appeals || !punishments || !notifier) {
    return undefined;
  }

  if (action === "new") {
    const record = punishments.get(args[0]);
    if (!record || record.userId !== userId) {
      // 只有当事人能申诉；无权时不产生任何群消息（避免在群里暴露申诉行为）
      return undefined;
    }
    // §B8：还有待处理申诉时不再重复发引导卡（否则被处罚人可以反复点、骚扰审核员）
    const pending = appeals.pendingFor(record.recordId, userId);
    if (pending) {
      await notifier.notifyAppellant(userId, duplicateAppealCard(pending));
      return undefined;
    }
    const sent = await notifier.notifyAppellant(
      userId,
      notifier.appealGuide(record, userId),
    );
    if (sent.ok) {
      log.info("appeal guide sent", {
        punishmentId: record.recordId,
        userId,
      });
      return undefined;
    }
    // §B8 降级：私信不可用（沙箱限制 / 从没私聊过机器人 / 主动消息被关）时，
    // 不能让申诉直接丢掉 —— 直接按**无理由**建单，审核员照常收到申诉通知；
    // 群里只回一条**不含申诉内容**的提示（与 `/whois` 私信失败的口径一致）。
    log.warn("appeal guide failed, submitting reason-less appeal", {
      punishmentId: record.recordId,
      userId,
      error: sent.detail,
    });
    return submitReasonlessAppeal(ctx, record, userId, true);
  }

  if (action === "submit") {
    const record = punishments.get(args[0]);
    if (!record || record.userId !== userId) {
      // 只有当事人能申诉；无权时不产生任何消息
      return undefined;
    }
    // §B8：已有待处理申诉 → 不再建新单（回执卡上会说明，避免刷单骚扰审核员）
    const pending = appeals.pendingFor(record.recordId, userId);
    if (pending) {
      const card = duplicateAppealCard(pending);
      return { ok: false, text: card.text, rich: card };
    }
    // 回调一键提交：不经过客户端发送，所以被禁言也能用；之后可在回执卡上「补充理由」
    return submitReasonlessAppeal(ctx, record, userId, false);
  }

  if (action === "accept" || action === "reject") {
    const appeal = appeals.get(args[0]);
    if (!appeal) {
      return cardFromText("申诉处理", "未找到该申诉记录。");
    }
    if (!ctx.permissions.canReviewContent(userId, appeal.groupId)) {
      return cardFromText("申诉处理", "权限不足：处理申诉需要审核员或以上权限。");
    }
    if (appeal.status !== "pending") {
      return cardFromText(
        "申诉处理",
        `该申诉已经处理过了（${appeal.status === "accepted" ? "已通过" : "已驳回"}）。`,
      );
    }
    const punishment = punishments.get(appeal.punishmentId);
    if (action === "reject") {
      await appeals.decide({
        code: appeal.appealId,
        reviewerId: userId,
        status: "rejected",
        note: "已驳回",
      });
      await afterAppealDecided(ctx, appeal, punishment, false, userId, "已驳回");
      const card = renderCard({
        title: "申诉已驳回",
        lines: [
          `**申诉**：#${appeal.appealId}`,
          `**处罚记录**：#${appeal.punishmentId}`,
          `**处理人**：${notifier.userLabelOf(userId)}`,
        ],
      });
      return { ok: true, text: card.text, rich: card };
    }
    const released = await punishments.release({
      code: appeal.punishmentId,
      actorId: userId,
      note: "通过申诉",
    });
    const note = released?.text ?? "已通过申诉";
    await appeals.decide({
      code: appeal.appealId,
      reviewerId: userId,
      status: "accepted",
      note,
    });
    await afterAppealDecided(ctx, appeal, punishment, true, userId, note);
    const card = renderCard({
      title: "申诉已通过",
      lines: [
        `**申诉**：#${appeal.appealId}`,
        `**处罚记录**：#${appeal.punishmentId}`,
        ...(released ? [released.text] : []),
      ],
      rows: [
        [
          viewButton(
            "view",
            "查看处罚",
            "punish",
            "view",
            appeal.punishmentId,
          ),
        ],
      ],
      footer: ["已按处罚记录逐项撤销（撤回与踢出无法恢复）。"],
    });
    void replyGroupId;
    return { ok: true, text: card.text, rich: card };
  }

  return undefined;
}
