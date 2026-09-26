import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  clampLimit,
  normalize,
  type CommandResult,
} from "./support.js";

/**
 * `/export audit [数量]`：审核日志 CSV 导出（§B6）。
 *
 * - 权限：该群**群管理员及以上**（复用 `ExportService` 的 `canExportData` 校验）；
 * - 脱敏：统一走 `maskIdentifier`（actor / target 只保留首字符），不导出 openid 原文；
 * - 落点：CSV 只**私信给操作者**；群里完全静默（连「已私信」都不回）。
 */
export const EXPORT_USAGE = [
  "用法：",
  "  /export audit [数量]                     导出本群审核日志（默认 10 条，最多 50 条）",
  "  /export audit <群号|#群短码> [数量]       私信里为指定群导出",
  "",
  "CSV 只私信给操作者本人（自动脱敏，不含 openid 原文），群里不回执。",
].join("\n");

export async function handleExport(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const action = normalize(parts[1]);
  if (action !== "audit" && action !== "审计" && action !== "日志") {
    return { ok: false, text: EXPORT_USAGE };
  }
  const targetGroupId = ctx.helpers.resolveTargetGroupId(
    groupId,
    groupId ? undefined : parts[2],
  );
  if (!targetGroupId) {
    return {
      ok: false,
      text: `导出需要在群内使用，或在私信中提供群号 / #群短码。\n\n${EXPORT_USAGE}`,
    };
  }
  const exportService = ctx.exportService;
  if (!exportService) {
    return { ok: false, text: "导出服务未启用。" };
  }
  if (!ctx.permissions.canExportData(userId, targetGroupId)) {
    return { ok: false, text: "权限不足：导出需要群管理员或以上权限。" };
  }
  const limitToken = parts
    .slice(2)
    .find((part) => /^\d+$/u.test(part) && part !== targetGroupId);
  const limit = clampLimit(limitToken);
  const records = ctx.auditLog
    .findByGroup(targetGroupId)
    .slice(-limit);
  let csv: string;
  try {
    csv = exportService.exportAuditRecordsCsv(userId, targetGroupId, records, true);
  } catch (error) {
    return {
      ok: false,
      text: `导出失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let delivered = false;
  let detail = "";
  const sender = ctx.richMessages;
  if (sender) {
    const sent = await sender.sendPlainToUser(userId, `\`\`\`\n${csv}\n\`\`\``);
    delivered = sent.ok;
    detail = sent.detail;
  } else {
    detail = "发送通道未启用";
  }
  const card = cardFromText(
    "审核日志导出",
    [
      `**群**：${ctx.helpers.groupLabel(targetGroupId)}`,
      `**条数**：${records.length}`,
      delivered
        ? "**结果**：CSV 已私信给你（已脱敏）。"
        : `**结果**：私信发送失败（${detail}），请先私聊机器人再试。`,
      "",
      EXPORT_USAGE,
    ].join("\n"),
  );
  return {
    ok: delivered,
    text: card.text,
    rich: card.rich,
    // §B4 静默：CSV 与结果都只走私信
    ...(groupId !== undefined ? { silent: true } : {}),
  };
}
