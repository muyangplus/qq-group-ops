import { extractPageToken } from "../callbackData.js";
import {
  escapeCardText,
  quoteCardLines,
  renderCard,
  type CardButton,
} from "../cardTemplate.js";
import { getLogger } from "../../core/logger.js";
import type { AdminCommandContext } from "./context.js";
import type { JoinRequest } from "../joinAudit.js";
import {
  actionButton,
  cardFromText,
  clampLimit,
  formatError,
  formatTime,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";
import { resolveRequestId } from "./targetResolvers.js";

/**
 * 审核域：待审批列表、通过 / 拒绝、官方同步、审计记录。
 *
 * 门面 `AdminCommandService` 保留同名公开方法（薄包装）；
 * 深链回调（`cb:pending:*` / `cb:sync:run` / `cb:audit:page`）仍由门面转调这里，
 * 业务逻辑集中在子模块，便于独立测试与复用。
 */

const log = getLogger("admin-commands");

export function resolveReviewTarget(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  parts: readonly string[],
): {
  targetGroupId: string | undefined;
  requestId: string | undefined;
  reasonParts: readonly string[];
} {
  if (groupId) {
    return {
      targetGroupId: groupId,
      requestId: resolveRequestId(ctx, parts[1]),
      reasonParts: parts.slice(2),
    };
  }
  const groupFromFirst = ctx.helpers.resolveTargetGroupId(undefined, parts[1]);
  if (groupFromFirst) {
    return {
      targetGroupId: groupFromFirst,
      requestId: resolveRequestId(ctx, parts[2]),
      reasonParts: parts.slice(3),
    };
  }
  const requestId = resolveRequestId(ctx, parts[1]);
  let targetGroupId: string | undefined;
  if (requestId) {
    try {
      targetGroupId = ctx.joinAudit.get(requestId).groupId;
    } catch {
      targetGroupId = undefined;
    }
  }
  return { targetGroupId, requestId, reasonParts: parts.slice(2) };
}

export function pendingCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
  notice?: string,
): CardResult {
  const { page, rest } = extractPageToken(parts);
  const targetGroupId = ctx.helpers.resolveTargetGroupId(groupId, rest[0]);
  if (!targetGroupId) {
    const card = renderCard({
      title: "待审批入群申请",
      lines: [
        "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
        "用法：/pending <群号|#群短码> [+页码]",
      ],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  if (!ctx.permissions.canReviewContent(userId, targetGroupId)) {
    const card = renderCard({
      title: "权限不足",
      lines: ["需要审核员或以上权限。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  const groupLabel = ctx.helpers.displayGroup(targetGroupId);
  const pending = ctx.joinAudit.pending(targetGroupId);
  if (pending.length === 0) {
    return cardFromText(
      "待审批入群申请",
      [
        ...ctx.helpers.renderNotice(notice),
        `群 ${groupLabel}：当前没有待审批入群申请。`,
      ].join("\n"),
      {
        rows: [
          [viewButton("refresh", "刷新", "pending", "page", targetGroupId, 1)],
        ],
        footer: [`本群：${groupLabel}`],
      },
    );
  }

  const pageSize = 3;
  const pageCount = Math.max(1, Math.ceil(pending.length / pageSize));
  const current = Math.min(Math.max(page, 1), pageCount);
  const slice = pending.slice((current - 1) * pageSize, current * pageSize);
  const config = ctx.configStore.get(targetGroupId);
  const withOpinion =
    config.joinReviewOpinion && ctx.joinRules !== undefined;

  const lines = [
    `**群**：${groupLabel}`,
    `**待审批**：共 ${pending.length} 条 · 第 ${current} / ${pageCount} 页`,
    ...ctx.helpers.renderNotice(notice),
  ];
  const rows: CardButton[][] = [];
  for (const request of slice) {
    const code = ctx.helpers.displayRequest(request.requestId);
    lines.push(
      "",
      `**${escapeCardText(code)}** · 申请人：${escapeCardText(ctx.helpers.displayUser(request.userId))}`,
      `理由：${escapeCardText(request.reason) || "（未填写）"}`,
    );
    if (withOpinion) {
      const evaluation = ctx.joinRules?.evaluate(request.reason, {
        mode: config.joinDecision,
        requireClass: config.joinRequireClass,
        requireName: config.joinRequireName,
        answerPattern: config.joinAnswerPattern,
        opinionEnabled: true,
      });
      if (evaluation?.opinion) {
        lines.push(...quoteCardLines(evaluation.opinion));
      }
    }
    rows.push([
      // 「通过」是固定动作（无需参数）→ 回调自动完成，并回一张刷新后的列表
      {
        ...viewButton(
          `approve-${code}`,
          "通过",
          "pending",
          "approve",
          targetGroupId,
          request.requestId,
          current,
        ),
        style: 1,
      },
      // 「拒绝」支持可选原因 → 保留指令按钮，用户可在发送前补上原因
      actionButton(`reject-${code}`, "拒绝", `/reject ${code}`, {
        style: 3,
        modal: {
          content: "确认拒绝该入群申请？（可先补上原因）",
          confirmText: "拒绝",
          cancelText: "取消",
        },
      }),
    ]);
  }

  const paging: CardButton[] = [];
  if (current > 1) {
    paging.push(
      viewButton("prev", "上一页", "pending", "page", targetGroupId, current - 1),
    );
  }
  if (current < pageCount) {
    paging.push(
      viewButton("next", "下一页", "pending", "page", targetGroupId, current + 1),
    );
  }
  paging.push(
    viewButton("refresh", "刷新", "pending", "page", targetGroupId, current),
  );
  rows.push(paging);

  const footer: string[] = [];
  if (current < pageCount) {
    footer.push(`下一页：/pending +${current + 1}`);
  }
  if (current > 1) {
    footer.push(`上一页：/pending +${current - 1}`);
  }

  return cardFromText("待审批入群申请", lines.join("\n"), {
    rows,
    footer,
  });
}

export async function approveCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  requestId: string,
  userId: string,
  page = 1,
  replyGroupId?: string,
): Promise<CardResult> {
  const back = viewButton("back", "返回待审批", "pending", "page", targetGroupId, page);
  if (!ctx.permissions.canApproveJoin(userId, targetGroupId)) {
    const card = renderCard({
      title: "权限不足",
      lines: ["通过入群申请需要群管理员或以上权限。"],
      rows: [[back]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  try {
    const request = ctx.joinAudit.get(requestId);
    if (request.groupId !== targetGroupId) {
      const card = renderCard({
        title: "审批失败",
        lines: ["申请不属于该群。"],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    await ctx.joinApproval.approve(targetGroupId, requestId, userId);
  } catch (error) {
    log.warn("approve via callback failed", {
      requestId,
      error: formatError(error),
    });
    const card = renderCard({
      title: "审批失败",
      lines: [formatError(error)],
      rows: [[back]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  log.info("approved join request via callback", { requestId, userId });
  return pendingCard(ctx,
    undefined,
    userId,
    ["pending", targetGroupId, `+${page}`],
    `${ctx.helpers.mention(replyGroupId, userId)}已通过 ${ctx.helpers.displayRequest(requestId)}`,
  );
}

export function auditCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  page = 1,
  limit = 20,
): CardResult {
  if (!ctx.permissions.canReviewContent(userId, targetGroupId)) {
    const card = renderCard({
      title: "权限不足",
      lines: ["需要审核员或以上权限。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  const groupLabel = ctx.helpers.displayGroup(targetGroupId);
  const size = limit > 0 ? limit : 20;
  // 最新的记录在前
  const all = ctx.auditLog.findByGroup(targetGroupId).slice().reverse();
  if (all.length === 0) {
    return cardFromText("审计记录", `群 ${groupLabel}：暂无审计记录。`, {
      rows: [
        [viewButton("refresh", "刷新", "audit", "page", targetGroupId, size, 1)],
      ],
      footer: [`本群：${groupLabel}`],
    });
  }
  const pageCount = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(page, 1), pageCount);
  const slice = all.slice((current - 1) * size, current * size);
  const lines = [
    `**群**：${groupLabel}`,
    `**审计记录**：共 ${all.length} 条 · 第 ${current} / ${pageCount} 页（每页 ${size}）`,
  ];
  for (const record of slice) {
    const target = record.targetUserId
      ? ` → ${ctx.helpers.displayUser(record.targetUserId)}`
      : "";
    lines.push(
      `${formatTime(record.createdAt)} ${record.action} ${record.status}${
        record.actorId ? ` by ${ctx.helpers.displayUser(record.actorId)}` : ""
      }${target}`,
    );
  }
  const paging: CardButton[] = [];
  if (current > 1) {
    paging.push(
      viewButton("prev", "上一页", "audit", "page", targetGroupId, size, current - 1),
    );
  }
  if (current < pageCount) {
    paging.push(
      viewButton("next", "下一页", "audit", "page", targetGroupId, size, current + 1),
    );
  }
  paging.push(
    viewButton("refresh", "刷新", "audit", "page", targetGroupId, size, current),
  );
  const footer: string[] = [`本群：${groupLabel}`];
  return cardFromText("审计记录", lines.join("\n"), {
    rows: [paging],
    footer,
  });
}

export async function syncCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  replyGroupId?: string,
): Promise<CardResult> {
  const back = viewButton(
    "pending",
    "查看待审批",
    "pending",
    "page",
    targetGroupId,
    1,
  );
  if (!ctx.permissions.canReviewContent(userId, targetGroupId)) {
    const card = renderCard({
      title: "权限不足",
      lines: ["需要审核员或以上权限。"],
      rows: [[back]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  let pending;
  try {
    pending = await ctx.joinSync.syncGroup(targetGroupId);
  } catch (error) {
    log.warn("join sync failed", {
      groupId: targetGroupId,
      error: formatError(error),
    });
    const card = renderCard({
      title: "同步失败",
      lines: [
        ...(ctx.helpers.mention(replyGroupId, userId).trimEnd()
          ? [ctx.helpers.mention(replyGroupId, userId).trimEnd()]
          : []),
        formatError(error),
      ],
      rows: [[back]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  await notifyPending(ctx, targetGroupId, pending).catch(() => undefined);
  const operator = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const lines = [
    ...(operator ? [operator] : []),
    `**群**：${ctx.helpers.displayGroup(targetGroupId)}`,
    `**结果**：已同步官方待审批申请，当前待审批 ${pending.length} 条`,
  ];
  for (const request of pending.slice(0, 5)) {
    const reason = request.reason ? ` 理由：${request.reason}` : "";
    lines.push(
      `- ${escapeCardText(ctx.helpers.displayRequest(request.requestId))} 用户：${escapeCardText(ctx.helpers.displayUser(request.userId))}${escapeCardText(reason)}`,
    );
  }
  if (pending.length > 5) {
    lines.push("（仅显示前 5 条，点下方按钮查看全部）");
  }
  return cardFromText("同步结果", lines.join("\n"), {
    rows: [[back]],
  });
}

export function approvalResultCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  message: string,
  ok: boolean,
  replyGroupId?: string,
): CardResult {
  const card = renderCard({
    title: ok ? "审批结果" : "审批失败",
    lines: [
      ...(ctx.helpers.mention(replyGroupId, userId).trimEnd()
        ? [ctx.helpers.mention(replyGroupId, userId).trimEnd()]
        : []),
      message,
    ],
    rows: [
      [
        viewButton("back", "返回待审批", "pending", "page", targetGroupId, 1),
        viewButton("audit", "查看审计", "audit", "page", targetGroupId, 20, 1),
      ],
    ],

  });
  return { ok, text: card.text, rich: card };
}

export async function notifyPending(
  ctx: AdminCommandContext,
  groupId: string,
  requests: readonly JoinRequest[],
): Promise<void> {
  if (!ctx.notifications) {
    return;
  }
  for (const request of requests) {
    await ctx.notifications
      .notifyJoinRequest({
        groupId,
        requestId: request.requestId,
        userId: request.userId,
        reason: request.reason,
      })
      .catch((error: unknown) => {
        log.warn("notify pending join request failed", {
          groupId,
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

export function handlePending(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): CommandResult {
  return pendingCard(ctx, groupId, userId, parts);
}

export async function handleApprove(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const resolved = resolveReviewTarget(ctx, groupId, parts);
  const { targetGroupId, requestId } = resolved;
  if (!targetGroupId || !requestId) {
    return {
      ok: false,
      text:
        "用法：\n" +
        "  /approve <#申请短码>                         群内审批本群\n" +
        "  /approve <群号|#群短码> <#申请短码>            私信中审批指定群\n" +
        "  /approve <#申请短码>                         私信中也可以（自动定位该申请所属群）",
    };
  }
  if (!ctx.permissions.canApproveJoin(userId, targetGroupId)) {
    return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
  }
  try {
    const request = ctx.joinAudit.get(requestId);
    if (request.groupId !== targetGroupId) {
      return { ok: false, text: "申请不属于该群。" };
    }
    await ctx.joinApproval.approve(targetGroupId, requestId, userId);
  } catch (error) {
    log.warn("approve failed", { requestId, error: formatError(error) });
    return { ok: false, text: `审批失败：${formatError(error)}` };
  }
  log.info("approved join request", { requestId, userId });
  return approvalResultCard(ctx,
    targetGroupId,
    userId,
    `已通过入群申请 ${ctx.helpers.displayRequest(requestId)}。`,
    true,
    groupId,
  );
}

export async function handleReject(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const { targetGroupId, requestId, reasonParts } = resolveReviewTarget(ctx,
    groupId,
    parts,
  );
  if (!targetGroupId || !requestId) {
    return {
      ok: false,
      text:
        "用法：\n" +
        "  /reject <#申请短码> [原因]                    群内审批本群\n" +
        "  /reject <群号|#群短码> <#申请短码> [原因]      私信中审批指定群\n" +
        "  /reject <#申请短码> [原因]                    私信中也可以（自动定位该申请所属群）",
    };
  }
  if (!ctx.permissions.canApproveJoin(userId, targetGroupId)) {
    return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
  }
  const reason = reasonParts.join(" ").trim();
  try {
    const request = ctx.joinAudit.get(requestId);
    if (request.groupId !== targetGroupId) {
      return { ok: false, text: "申请不属于该群。" };
    }
    await ctx.joinApproval.reject(targetGroupId, requestId, userId, reason);
  } catch (error) {
    log.warn("reject failed", { requestId, error: formatError(error) });
    return { ok: false, text: `审批失败：${formatError(error)}` };
  }
  log.info("rejected join request", {
    requestId,
    userId,
    hasReason: reason.length > 0,
  });
  return approvalResultCard(ctx,
    targetGroupId,
    userId,
    `已拒绝入群申请 ${ctx.helpers.displayRequest(requestId)}。`,
    true,
    groupId,
  );
}

export function handleAudit(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): CommandResult {
  const { page, rest } = extractPageToken(parts);
  const targetGroupId = ctx.helpers.resolveTargetGroupId(groupId, rest[0]);
  if (!targetGroupId) {
    const card = renderCard({
      title: "审计记录",
      lines: [
        "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
        "用法：/audit [群号|#群短码] [每页数量] [+页码]",
      ],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  const limit = clampLimit(groupId !== undefined ? rest[0] : rest[1]);
  return auditCard(ctx, targetGroupId, userId, page, limit);
}
