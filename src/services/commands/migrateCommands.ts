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

/** 迁移前的二次确认弹窗（与「重启」「恢复继承」同一套不可逆动作规范）。 */
export function confirmMigrateModal(): KeyboardModal {
  return {
    content:
      "确认迁移？会改写库里的旧格式数据（老处罚字段 / 四位年级 / 小写短码），执行前请确认已经备份。",
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
              // 不用官方 `modal`（内邀能力，未开通时客户端会把这个按钮整个丢掉）：
              // 点一下出**确认卡**，再点「确定开始」才真正迁移。
              viewButton("run", "开始迁移", "migrate", "request"),
            ]
          : []),
        viewButton("help", "指令帮助", "help", "topic", "migrate"),
      ],
    ],
  });
}

/**
 * 回调 `cb:migrate:request`：**确认卡**（不依赖官方弹窗的两步确认）。
 *
 * 「开始迁移」→ 本卡列出待改写条数 + 备份提醒 → 「确定开始」才执行。
 */
export async function migrateConfirmCard(
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
    "确认现在迁移吗？**会改写数据库里的老格式数据**（不可撤销，除非你回滚备份）。",
    "",
    "将改写：",
    ...countLines(counts),
    "",
    "执行前请确认已经备份数据库；迁移幂等，重复执行不会重复改写。",
    totalPending(counts) > 0
      ? ""
      : "（当前扫描没有待改写项，确定也无事发生。）",
  ].join("\n");
  return cardFromText("确认迁移", text, {
    rows: [
      [
        viewButton("confirm", "确定开始", "migrate", "run"),
        viewButton("cancel", "取消", "migrate", "preview"),
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
