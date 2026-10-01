import { randomUUID } from "node:crypto";

import { AuditStatus, PlatformLevel } from "../../core/enums.js";
import { getLogger } from "../../core/logger.js";
import {
  PRIVACY_TARGETS,
  type PrivacyCounts,
} from "../../db/privacyRepository.js";
import { renderCard } from "../cardTemplate.js";
import type { AdminCommandContext } from "./context.js";
import {
  actionButton,
  cardFromText,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";
import { resolveUserId } from "./targetResolvers.js";

const log = getLogger("admin-commands");

const DATA_USAGE = [
  "用法（仅全局超管、只在私信）：",
  "  /data delete <#用户短码|QQ号|openid> [理由]   预览：列出该用户的数据条数（只读）",
  "  /data anonymize <同上> [理由]                执行匿名化（不可逆：行保留、user_id 换成占位值）",
  "  /data export <同上>                          把该用户的数据导出成 CSV 私信给你",
].join("\n");

/**
 * `/data`：个人数据匿名化与导出（D7）。
 *
 * 口径见 `TODO.md` §2 D7 与 [docs/DATA-COMPLIANCE.md](../../../docs/DATA-COMPLIANCE.md)：
 * - 只在私信、只有全局超管能用（避免在群里暴露「查谁的数据」这个动作）；
 * - 删除是**匿名化**：行保留、`user_id` 换占位值、个人字段清空，幂等；
 * - `blacklist_entries` / `permission_grants` 保留生效、`audit_records` 保留（合规）。
 *
 * 为什么确认按钮是**指令按钮**而不是回调：`encodeCallback` 用 `:` 拼参数且不转义，
 * 自由文本理由会被 `:` 截断（还有官方 data 长度上限），所以 `/data delete` 只出预览卡，
 * 卡上「确认匿名化」发送 `/data anonymize …` 才真正执行——理由随指令文本走，直接进审计。
 */
export async function handleData(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  operatorId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const action = (parts[1] ?? "").trim().toLowerCase();
  const rawTarget = parts[2];
  const reason = parts.slice(3).join(" ").trim();

  const guard = dataGuard(ctx, groupId, operatorId, action, rawTarget);
  if (guard) {
    return guard;
  }
  const privacy = ctx.privacy!;
  const targetUserId = resolveUserId(ctx, rawTarget)!;

  if (["delete", "删除", "preview", "预览"].includes(action)) {
    const plan = await privacy.plan(targetUserId);
    return dataPreviewCard(ctx, targetUserId, plan.counts, plan.total, reason);
  }

  if (["anonymize", "匿名化", "confirm", "确认"].includes(action)) {
    const result = await privacy.anonymize(targetUserId);
    if (result.total === 0) {
      const card = cardFromText(
        "没有可匿名化的数据",
        `**目标**：${ctx.helpers.displayUser(targetUserId)}\n\n` +
          "可能已经处理过，或者这个人本来就没有数据。没有改动任何行。",
      );
      return { ok: false, text: card.text, rich: card.rich };
    }
    ctx.auditLog.append({
      recordId: randomUUID(),
      // 平台级动作不挂在任何群上（与 `/migrate`、全局黑名单同一口径）
      groupId: "",
      actorId: operatorId,
      action: "data_delete",
      status: AuditStatus.Executed,
      reason: `匿名化=${result.total} 占位值=${result.anonId}${
        reason.length > 0 ? ` 理由=${reason}` : ""
      }`,
      createdAt: new Date(),
    });
    log.info("personal data anonymized", {
      anonId: result.anonId,
      total: result.total,
      operatorId,
      hasReason: reason.length > 0,
    });
    const card = cardFromText(
      "已匿名化",
      [
        `**目标**：${ctx.helpers.displayUser(targetUserId)}`,
        `**占位值**：\`${result.anonId}\``,
        `**已处理**：共 ${result.total} 条`,
        "",
        ...countLines(result.counts),
        "",
        "行都还在（统计与去重不断），但已经无法关联到本人。重复执行不会再改动任何行。",
      ].join("\n"),
    );
    return { ok: true, text: card.text, rich: card.rich };
  }

  if (["export", "导出"].includes(action)) {
    const result = await privacy.exportCsv(targetUserId, operatorId);
    ctx.auditLog.append({
      recordId: randomUUID(),
      groupId: "",
      actorId: operatorId,
      action: "data_export",
      status: AuditStatus.Executed,
      // 导出本身不写库：只记「谁导了谁、多少行」，失败也留痕便于排查
      reason: `${ctx.helpers.displayUser(targetUserId)}=${result.rows} 行${
        result.ok ? "" : "（发送失败）"
      }`,
      createdAt: new Date(),
    });
    const card = cardFromText(
      "个人数据导出",
      `**目标**：${ctx.helpers.displayUser(targetUserId)}\n\n${result.text}`,
    );
    return { ok: result.ok, text: card.text, rich: card.rich };
  }

  return dataUsageCard(ctx);
}

/** 前置检查：功能已装配 + 只在私信 + 全局超管。 */
function dataGuard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  operatorId: string,
  action: string,
  rawTarget: string | undefined,
): CommandResult | undefined {
  if (!ctx.privacy?.configured) {
    const card = cardFromText(
      "个人数据",
      "功能未装配：需要连接数据库才能匿名化 / 导出个人数据。",
    );
    return { ok: false, text: card.text, rich: card.rich };
  }
  if (groupId !== undefined) {
    const card = cardFromText(
      "只在私信执行",
      "个人数据操作只在私信里执行（群里会把「查谁的数据」暴露给全群）。",
    );
    return { ok: false, text: card.text, rich: card.rich };
  }
  if (!ctx.permissions.meetsGlobal(operatorId, PlatformLevel.GlobalSuperAdmin)) {
    const card = cardFromText("权限不足", "需要全局超级管理员权限。");
    return { ok: false, text: card.text, rich: card.rich };
  }
  if (action.length === 0 || rawTarget === undefined) {
    return dataUsageCard(ctx);
  }
  if (resolveUserId(ctx, rawTarget) === undefined) {
    return dataUsageCard(ctx);
  }
  return undefined;
}

function dataUsageCard(_ctx: AdminCommandContext): CardResult {
  const card = cardFromText("个人数据", DATA_USAGE, {
    rows: [[viewButton("help", "指令帮助", "help", "home")]],
  });
  return { ...card, ok: false };
}

/** 预览卡：只读列出待匿名化条数；确认按钮发送 `/data anonymize …`。 */
function dataPreviewCard(
  ctx: AdminCommandContext,
  targetUserId: string,
  counts: PrivacyCounts,
  total: number,
  reason: string,
): CardResult {
  const confirmCommand = `/data anonymize ${targetUserId}${
    reason.length > 0 ? ` ${reason}` : ""
  }`;
  const lines = [
    `**目标**：${ctx.helpers.displayUser(targetUserId)}`,
    `**待匿名化**：共 ${total} 条`,
    "",
    ...countLines(counts),
    "",
    "匿名化**不可撤销**：所有相关行的 `user_id` 会换成一次性占位值、个人字段清空（行保留，不物理删除）。",
    "重复执行不会再改动任何行。",
    reason.length > 0 ? `**理由**：${reason}` : "（没有写理由，审计里记为未填写）",
  ];
  return cardFromText("删除个人数据", lines.join("\n"), {
    rows: [
      [
        actionButton("confirm", "确认匿名化", confirmCommand, { style: 3 }),
        viewButton("help", "指令帮助", "help", "home"),
      ],
    ],
    footer: ["点「确认匿名化」= 发送上面那条指令；也可以手输同样的指令。"],
  });
}

/** 按表列出条数（只列非 0，避免刷屏）。 */
export function countLines(counts: PrivacyCounts): string[] {
  const lines = PRIVACY_TARGETS.filter((target) => counts[target.key] > 0).map(
    (target) => `- ${target.label}：${counts[target.key]} 条`,
  );
  return lines.length > 0 ? lines : ["（无）"];
}
