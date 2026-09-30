import { randomUUID } from "node:crypto";

import type { KeyboardModal } from "../../adapters/qqOfficial.js";
import { AuditStatus, PlatformLevel } from "../../core/enums.js";
import { encodeCallback } from "../callbackData.js";
import { renderCard } from "../cardTemplate.js";
import { totalPending, type MigrationCounts } from "../dataMigration.js";
import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  viewButton,
  viewButtonWithOptions,
  type CardResult,
} from "./support.js";

/**
 * 迁移前的二次确认弹窗（官方 `action.modal`）。
 *
 * 文案必须 **≤40 字**：官方对整条消息做校验，超限会让**整块键盘**一起丢
 * （见 ADR-0054，`cardTemplate` 也会兜底截断）。当前文案 21 字。
 */
export function confirmMigrateModal(): KeyboardModal {
  return {
    content: "确认迁移？会改写老格式数据，请确认已备份。",
    confirmText: "确认迁移",
    cancelText: "取消",
  };
}

function isSuperAdmin(ctx: AdminCommandContext, userId: string): boolean {
  return ctx.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin);
}

function denied(title: string, text: string): CardResult {
  const card = renderCard({
    title,
    lines: [text],
    rows: [[viewButton("help", "指令帮助", "help", "topic", "migrate")]],
  });
  return { ok: false, text: card.text, rich: card };
}

/**
 * 前置检查：全局超管 + 只在私信执行 + 已连接数据库。
 *
 * 返回 `undefined` 表示可以继续，否则返回拒绝卡。
 */
function blocked(
  ctx: AdminCommandContext,
  userId: string,
  groupId: string | undefined,
): CardResult | undefined {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("权限不足", "数据迁移只有全局超管可以操作。");
  }
  if (groupId !== undefined) {
    return denied(
      "请在私信中执行",
      "数据迁移会改写数据库，只在私信中执行：请私信机器人发送 /migrate。",
    );
  }
  if (!ctx.migrate?.persistent) {
    return denied(
      "迁移不可用",
      "当前进程没有连接数据库，无法迁移（纯测试环境或直接导入服务层调用时如此）。",
    );
  }
  return undefined;
}

/** 各项的中文名与单位（0 的项不显示）。 */
const COUNT_ROWS: readonly (readonly [keyof MigrationCounts, string, string])[] = [
  ["settings", "群配置键值", "行"],
  ["legacyPunishGroups", "违规处理老字段", "个群"],
  ["profileYears", "个人资料年级", "条"],
  ["activityCodes", "活动短码", "条"],
  ["activityYears", "活动报名年级", "条"],
  ["shortCodes", "短码", "条"],
];

/** 待迁移清单正文。 */
function countLines(counts: MigrationCounts): string[] {
  const rows = COUNT_ROWS.filter(([key]) => counts[key] > 0).map(
    ([key, label, unit]) => `  ${label}：${counts[key]} ${unit}`,
  );
  return rows.length > 0 ? rows : ["  （无）"];
}

/** `/migrate`：只读预览待迁移条数，附「确认迁移」按钮。 */
export async function migrateCard(
  ctx: AdminCommandContext,
  userId: string,
  groupId: string | undefined,
): Promise<CardResult> {
  const guard = blocked(ctx, userId, groupId);
  if (guard) {
    return guard;
  }
  const counts = await ctx.migrate!.plan();
  const pending = totalPending(counts) > 0;
  const text = [
    "把库里早期版本写下的内容转成现行格式（迁移之前，这些数据不会被读取）。",
    "",
    "待改写：",
    ...countLines(counts),
    "",
    "执行前请先备份数据库；迁移幂等，已经转好的部分不会重复改写。",
  ].join("\n");
  return cardFromText("数据迁移", text, {
    rows: [
      [
        ...(pending
          ? [
              // 确认走官方 `action.modal`：点「开始迁移」→ 弹窗确认 → 真正改写。
              // 弹窗文案必须 ≤40 字，超限会让整块键盘一起丢（ADR-0054）。
              viewButtonWithOptions(
                "run",
                "开始迁移",
                encodeCallback("migrate", "run"),
                { modal: confirmMigrateModal() },
              ),
            ]
          : []),
        viewButton("help", "指令帮助", "help", "topic", "migrate"),
      ],
    ],
  });
}

/** 回调 `cb:migrate:run`：执行迁移并回执（写入审计）。 */
export async function migrateRunCard(
  ctx: AdminCommandContext,
  userId: string,
  groupId: string | undefined,
): Promise<CardResult> {
  const guard = blocked(ctx, userId, groupId);
  if (guard) {
    return guard;
  }
  const counts = await ctx.migrate!.run();
  const changed = totalPending(counts) > 0;
  const backup = ctx.migrate!.lastBackup;
  const backupLines = backup
    ? backup.ok
      ? [`**已自动备份**：\`${backup.path ?? ""}\``]
      : backup.skipped !== undefined
        ? [`**未自动备份**：${backup.skipped}`]
        : [`**自动备份失败**：${backup.detail}（迁移仍已执行）`]
    : [];
  ctx.auditLog.append({
    recordId: randomUUID(),
    // 平台级动作不挂在任何群上（与全局黑名单 / 授权同一口径）
    groupId: "",
    actorId: userId,
    action: "data_migrate",
    status: AuditStatus.Executed,
    reason: COUNT_ROWS.filter(([key]) => counts[key] > 0)
      .map(([key, label]) => `${label}=${counts[key]}`)
      .join(" ") || "nothing_pending",
    createdAt: new Date(),
  });
  const text = [
    changed
      ? "已把库里的旧格式数据转成现行格式："
      : "没有需要改写的项，库里的数据已经是现行格式。",
    ...(changed ? ["", "本次改写：", ...countLines(counts)] : []),
    ...(backupLines.length > 0 ? ["", ...backupLines] : []),
  ].join("\n");
  return cardFromText("数据迁移完成", text, {
    rows: [
      [
        viewButton("refresh", "重新扫描", "migrate", "preview"),
        viewButton("help", "指令帮助", "help", "topic", "migrate"),
      ],
    ],
  });
}

/** 回调 `cb:migrate:preview`：迁移后再扫一遍，确认已经没有待改写项。 */
export async function migrateRefreshCard(
  ctx: AdminCommandContext,
  userId: string,
  groupId: string | undefined,
): Promise<CardResult> {
  const guard = blocked(ctx, userId, groupId);
  if (guard) {
    return guard;
  }
  const counts = await ctx.migrate!.plan();
  const text = [
    "重新扫描结果：",
    ...countLines(counts),
    "",
    totalPending(counts) === 0
      ? "库里的数据已经是现行格式。"
      : "仍有待改写项，可以再次执行 /migrate。",
  ].join("\n");
  return cardFromText("数据迁移", text, {
    rows: [[viewButton("help", "指令帮助", "help", "topic", "migrate")]],
  });
}
