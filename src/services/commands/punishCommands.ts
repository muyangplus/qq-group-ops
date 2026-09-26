import type { BlacklistScope } from "../../db/blacklistRepository.js";
import type { PunishmentRecord } from "../../db/punishmentRepository.js";
import { renderCard } from "../cardTemplate.js";
import type { CardButton } from "../cardTemplate.js";
import {
  buildModerationReceipt,
  buildMuteOptionsCard,
  describePunishmentActions,
} from "../moderationCards.js";
import { normalizeCode } from "../punishments.js";
import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  formatTime,
  normalize,
  parseDuration,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

/**
 * `/punish` 领域模块（§B7）。
 *
 * 处罚通知是私信卡片，上面的按钮走 `cb:punish:*` 回调；这里同时提供等价的指令入口，
 * 保证「按钮不可用 / 想复制粘贴」时仍能调整处罚。权限：该群审核员及以上。
 */

const PAGE_SIZE = 4;

export const PUNISH_USAGE = [
  "用法（需要该群审核员及以上权限）：",
  "  /punish <#处罚短码>                 查看处罚详情与可执行动作",
  "  /punish list [+页码]                本群最近处罚记录",
  "  /punish release <#处罚短码> [说明]   解除处罚（解除禁言 / 解除拉黑）",
  "  /punish mute <#处罚短码> <秒>        修改禁言时长（0 = 解除禁言）",
  "  /punish kick <#处罚短码>             移出群",
  "  /punish blacklist <#处罚短码> [全局] [原因]  拉黑（默认本群）",
].join("\n");

/** `/punish ...` 指令入口。 */
export async function handlePunish(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const punishments = ctx.punishments;
  if (!punishments) {
    return { ok: false, text: "处罚记录服务未启用。" };
  }
  const action = normalize(parts[1]);
  if (!action || action === "list" || action === "列表") {
    const targetGroupId = ctx.helpers.resolveTargetGroupId(
      groupId,
      groupId ? undefined : parts[2],
    );
    if (!targetGroupId) {
      return { ok: false, text: `该指令需要在群内使用，或在私信中提供群号 / #群短码。\n\n${PUNISH_USAGE}` };
    }
    if (!ctx.permissions.canReviewContent(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：处罚管理需要审核员或以上权限。" };
    }
    const pageToken = parts.find((part) => /^\+\d+$/u.test(part));
    const page = pageToken ? Number.parseInt(pageToken.slice(1), 10) : 1;
    return punishListCard(ctx, targetGroupId, page, userId);
  }

  // `/punish <#处罚短码>`：直接看详情
  const direct = punishments.get(parts[1]);
  if (direct && !["release", "mute", "kick", "blacklist"].includes(action)) {
    return punishDetailCard(ctx, direct, userId);
  }

  const codeRaw = parts[2];
  const record = punishments.get(codeRaw);
  if (!record) {
    return { ok: false, text: `未找到处罚记录：${codeRaw ?? "（缺参数）"}\n\n${PUNISH_USAGE}` };
  }
  const denied = requireReviewer(ctx, record, userId);
  if (denied) {
    return { ok: false, text: denied };
  }

  if (action === "release" || action === "解除") {
    const note = parts.slice(3).join(" ");
    const result = await punishments.release({ code: record.recordId, actorId: userId, note });
    if (!result) {
      return { ok: false, text: "未找到该处罚记录。" };
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已解除处罚");
    }
    return receiptResult(ctx, result.record, userId, result.ok ? "已解除处罚" : "解除失败", result.text);
  }

  if (action === "mute" || action === "禁言") {
    const secondsRaw = parts[3];
    if (secondsRaw === undefined) {
      return { ok: false, text: PUNISH_USAGE };
    }
    let seconds: number;
    try {
      seconds = parseDuration(secondsRaw);
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
    const result = await punishments.setMute({ code: record.recordId, seconds, actorId: userId });
    if (!result) {
      return { ok: false, text: "未找到该处罚记录。" };
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已调整禁言时长");
    }
    return receiptResult(ctx, result.record, userId, "已调整禁言时长", result.text);
  }

  if (action === "kick" || action === "踢出") {
    const result = await punishments.kick({ code: record.recordId, actorId: userId });
    if (!result) {
      return { ok: false, text: "未找到该处罚记录。" };
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已移出群");
    }
    return receiptResult(ctx, result.record, userId, "已移出群", result.text);
  }

  if (action === "blacklist" || action === "拉黑") {
    const scope: BlacklistScope =
      parts[3] === "全局" || parts[3] === "global" ? "global" : "group";
    if (scope === "global" && !ctx.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：全局拉黑仅超级管理员可操作。" };
    }
    const reason = parts
      .slice(3 + (parts[3] === "全局" || parts[3] === "global" ? 1 : 0))
      .join(" ");
    const result = await punishments.blacklistUser({
      code: record.recordId,
      scope,
      actorId: userId,
      reason,
    });
    if (!result) {
      return { ok: false, text: "未找到该处罚记录。" };
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已拉黑");
    }
    return receiptResult(
      ctx,
      result.record,
      userId,
      scope === "global" ? "已全局拉黑" : "已拉黑本群",
      result.text,
    );
  }

  return { ok: false, text: PUNISH_USAGE };
}

/** 处罚详情卡（复用处罚通知卡：正文 + 全部调整按钮）。 */
export function punishDetailCard(
  ctx: AdminCommandContext,
  record: PunishmentRecord,
  viewerId: string,
): CardResult {
  const denied = requireReviewer(ctx, record, viewerId);
  if (denied) {
    const card = cardFromText("处罚详情", denied);
    return { ok: false, text: card.text, rich: card.rich };
  }
  const card = ctx.moderationNotifier?.punishmentCard(record, viewerId);
  if (card) {
    return { ok: true, text: card.text, rich: card };
  }
  const fallback = renderCard({
    title: "处罚详情",
    lines: punishmentDetailLines(ctx, record),
    rows: [
      [
        viewButton("release", "解除处罚", "punish", "release", record.recordId),
      ],
    ],
    footer: [PUNISH_USAGE],
  });
  return { ok: true, text: fallback.text, rich: fallback };
}

/** 本群处罚记录列表卡（每页 4 条，点「查看N」进详情）。 */
export function punishListCard(
  ctx: AdminCommandContext,
  groupId: string,
  page: number,
  viewerId: string,
  notice?: string,
): CardResult {
  const punishments = ctx.punishments;
  if (!punishments) {
    return cardFromText("处罚记录", "处罚记录服务未启用。");
  }
  const records = punishments.listByGroup(groupId, Number.MAX_SAFE_INTEGER);
  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = records.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const lines = [
    ...ctx.helpers.renderNotice(notice),
    `**群**：${ctx.helpers.groupLabel(groupId)}`,
    `**记录数**：${records.length}（第 ${current}/${totalPages} 页）`,
  ];
  if (slice.length === 0) {
    lines.push("", "（暂无处罚记录）");
  } else {
    lines.push("");
    slice.forEach((record, index) => {
      lines.push(
        `${(current - 1) * PAGE_SIZE + index + 1}. #${record.recordId}` +
          ` ${ctx.helpers.displayUser(record.userId)}` +
          ` — ${record.status === "released" ? "已解除" : "生效中"}` +
          ` @ ${formatTime(record.createdAt)}`,
      );
    });
  }
  const rows: CardButton[][] = [];
  if (slice.length > 0) {
    rows.push(
      slice.map((record, index) =>
        viewButton(
          `view-${index}`,
          `查看${index + 1}`,
          "punish",
          "view",
          record.recordId,
        ),
      ),
    );
  }
  const nav: CardButton[] = [];
  if (current > 1) {
    nav.push(viewButton("prev", "上一页", "punish", "list", groupId, current - 1));
  }
  if (current < totalPages) {
    nav.push(viewButton("next", "下一页", "punish", "list", groupId, current + 1));
  }
  if (nav.length > 0) {
    rows.push(nav);
  }
  return cardFromText("处罚记录", lines.join("\n"), {
    rows,
    footer: ["「查看N」仅对本群审核员及以上可见。", PUNISH_USAGE],
  });
}

/**
 * `cb:punish:*` 回调入口。
 *
 * 每次点击都**重新鉴权**（不能信按钮），返回的结果卡会发回点击所在会话（私信卡片就回私信）。
 */
export async function punishCallbackCard(
  ctx: AdminCommandContext,
  action: string,
  args: readonly string[],
  userId: string,
  replyGroupId?: string,
): Promise<CardResult | undefined> {
  const punishments = ctx.punishments;
  if (!punishments) {
    return cardFromText("处罚记录", "处罚记录服务未启用。");
  }
  if (action === "list") {
    const [targetGroupId, page] = args;
    if (!targetGroupId) {
      return undefined;
    }
    if (!ctx.permissions.canReviewContent(userId, targetGroupId)) {
      return cardFromText("处罚记录", "权限不足：处罚管理需要审核员或以上权限。");
    }
    return punishListCard(
      ctx,
      targetGroupId,
      Number.parseInt(page ?? "1", 10) || 1,
      userId,
    );
  }

  const code = args[0];
  const record = punishments.get(code);
  if (!record) {
    return cardFromText("处罚记录", `未找到处罚记录：#${code ?? ""}`);
  }
  const denied = requireReviewer(ctx, record, userId);
  if (denied) {
    return cardFromText("处罚记录", denied);
  }

  if (action === "view") {
    return punishDetailCard(ctx, record, userId);
  }
  if (action === "mute") {
    const notifier = ctx.moderationNotifier;
    const card = buildMuteOptionsCard({
      recordId: record.recordId,
      userLabel: notifier?.userLabelOf(record.userId) ?? record.userId,
      groupLabel: notifier?.groupLabelOf(record.groupId) ?? record.groupId,
      currentSeconds: record.actions.muteDurationSeconds,
      recipientId: userId,
      withButtons: notifier?.keyboardAvailable ?? true,
    });
    return { ok: true, text: card.text, rich: card };
  }
  if (action === "setmute") {
    const seconds = Number.parseInt(args[1] ?? "", 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return undefined;
    }
    const result = await punishments.setMute({
      code: record.recordId,
      seconds,
      actorId: userId,
    });
    if (!result) {
      return undefined;
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已调整禁言时长");
    }
    return receiptResult(ctx, result.record, userId, "已调整禁言时长", result.text);
  }
  if (action === "release") {
    const result = await punishments.release({
      code: record.recordId,
      actorId: userId,
    });
    if (!result) {
      return undefined;
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已解除处罚");
    }
    return receiptResult(ctx, result.record, userId, "已解除处罚", result.text);
  }
  if (action === "kick") {
    const result = await punishments.kick({
      code: record.recordId,
      actorId: userId,
    });
    if (!result) {
      return undefined;
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已移出群");
    }
    return receiptResult(ctx, result.record, userId, "已移出群", result.text);
  }
  if (action === "blacklist") {
    const scope: BlacklistScope = args[1] === "global" ? "global" : "group";
    if (scope === "global" && !ctx.permissions.isSuperAdmin(userId)) {
      return cardFromText("处罚记录", "权限不足：全局拉黑仅超级管理员可操作。");
    }
    const result = await punishments.blacklistUser({
      code: record.recordId,
      scope,
      actorId: userId,
    });
    if (!result) {
      return undefined;
    }
    if (result.ok) {
      await acceptAppeals(ctx, record.recordId, userId, "已拉黑");
    }
    return receiptResult(
      ctx,
      result.record,
      userId,
      scope === "global" ? "已全局拉黑" : "已拉黑本群",
      result.text,
    );
  }
  void replyGroupId;
  return undefined;
}

/** 审核员及以上才能调整处罚。 */
function requireReviewer(
  ctx: AdminCommandContext,
  record: PunishmentRecord,
  userId: string,
): string | undefined {
  return ctx.permissions.canReviewContent(userId, record.groupId)
    ? undefined
    : "权限不足：处罚管理需要审核员或以上权限。";
}

/** 调整处罚后把该处罚下的待处理申诉标记为已处理。 */
async function acceptAppeals(
  ctx: AdminCommandContext,
  punishmentId: string,
  reviewerId: string,
  note: string,
): Promise<void> {
  await ctx.appeals?.acceptByPunishment({ punishmentId, reviewerId, note });
}

function receiptResult(
  ctx: AdminCommandContext,
  record: PunishmentRecord,
  recipientId: string,
  title: string,
  text: string,
): CardResult {
  const notifier = ctx.moderationNotifier;
  const card =
    notifier?.keyboardAvailable === false
      ? buildModerationReceipt({
          title,
          lines: [text, ...punishmentDetailLines(ctx, record)],
          recordId: record.recordId,
          recipientId,
          withButtons: false,
        })
      : buildModerationReceipt({
          title,
          lines: [text, ...punishmentDetailLines(ctx, record)],
          recordId: record.recordId,
          recipientId,
          withButtons: true,
        });
  return { ok: true, text: card.text, rich: card };
}

function punishmentDetailLines(
  ctx: AdminCommandContext,
  record: PunishmentRecord,
): string[] {
  const notifier = ctx.moderationNotifier;
  return [
    `**记录**：#${record.recordId}`,
    `**群**：${notifier?.groupLabelOf(record.groupId) ?? ctx.helpers.groupLabel(record.groupId)}`,
    `**当事人**：${notifier?.userLabelOf(record.userId) ?? ctx.helpers.displayUser(record.userId)}`,
    `**命中规则**：${record.ruleReason || "（关键词）"}`,
    `**动作**：${describePunishmentActions(record.actions)}`,
    `**状态**：${record.status === "released" ? "已解除" : "生效中"}`,
    ...(record.detail ? [`**执行结果**：${record.detail}`] : []),
    `**时间**：${formatTime(record.createdAt)}`,
  ];
}
