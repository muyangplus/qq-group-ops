import { renderCard } from "../cardTemplate.js";
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
  const reason = parts.slice(2).join(" ");
  const result = await appeals.submit({ punishment: record, userId, reason });
  const receipt = notifier.appealReceipt(result.appeal, result.updated);
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
    buttonHint: "相关入口：",
    footer: [APPEAL_USAGE],
  });
}

/**
 * `cb:appeal:*` 回调入口。
 *
 * - `new`：群内警告卡的「我要申诉」按钮 → 只私信引导卡给当事人，**不在群里发任何消息**
 *   （返回 `undefined`，由 CallbackRouter 只回包）；
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
    await notifier.notifyAppellant(userId, notifier.appealGuide(record, userId));
    return undefined;
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
      const card = renderCard({
        title: "申诉已驳回",
        lines: [
          `**申诉**：#${appeal.appealId}`,
          `**处罚记录**：#${appeal.punishmentId}`,
          `**处理人**：${notifier.userLabelOf(userId)}`,
        ],
        footer: ["处罚保持不变。"],
      });
      return { ok: true, text: card.text, rich: card };
    }
    const released = await punishments.release({
      code: appeal.punishmentId,
      actorId: userId,
      note: "通过申诉",
    });
    await appeals.decide({
      code: appeal.appealId,
      reviewerId: userId,
      status: "accepted",
      note: released?.text ?? "已通过申诉",
    });
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
      buttonHint: "下一步：",
      footer: ["已按处罚记录逐项撤销（撤回与踢出无法恢复）。"],
    });
    void replyGroupId;
    return { ok: true, text: card.text, rich: card };
  }

  return undefined;
}
