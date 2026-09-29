import { PlatformLevel } from "../../core/enums.js";
import type { MigrationResult } from "../../db/migrate.js";
import type { HealthRegistry, ModuleKey } from "../health.js";
import { MODULE_LABELS } from "../health.js";
import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  viewButton,
  type CardResult,
} from "./support.js";

/**
 * 回调命名空间 → 功能域：模块降级时这些按钮一律拒绝执行（层 2 的四处闸门之一）。
 *
 * 不在这里的命名空间（`status` / `help` / `menu` / `health` / `test*` / `restart` / `deploy` / `migrate`）
 * 是诊断与恢复入口，模块全挂了也得能用。
 */
export const CALLBACK_MODULES: Readonly<Record<string, ModuleKey>> = {
  activity: "activity",
  rules: "config",
  notify: "notify",
  pending: "join",
  approve: "join",
  reject: "join",
  sync: "join",
  punish: "sanction",
  appeal: "sanction",
  blacklist: "blacklist",
  audit: "audit",
  export: "audit",
  perm: "permissions",
  profile: "profile",
  alias: "alias",
  bind: "identity",
  whois: "identity",
};

export function moduleForCallback(namespace: string): ModuleKey | undefined {
  return CALLBACK_MODULES[namespace];
}

/** 模块不可用时的统一拒绝卡：说清原因，并给超管一个「重试加载」。 */
export function moduleUnavailableCard(
  ctx: AdminCommandContext,
  userId: string,
  key: ModuleKey,
): CardResult {
  const reason =
    ctx.health?.reasonOf(key) ?? `「${MODULE_LABELS[key]}」当前不可用。`;
  const isSuperAdmin = ctx.permissions.meetsGlobal(
    userId,
    PlatformLevel.GlobalSuperAdmin,
  );
  const card = cardFromText(
    "功能不可用",
    [
      reason,
      "",
      "其它功能不受影响。修好原因后点「重试加载」即可恢复，不用重启。",
    ].join("\n"),
    {
      rows: [
        [
          ...(isSuperAdmin
            ? [viewButton("retry", "重试加载", "health", "retry", key)]
            : []),
          viewButton("status", "查看状态", "status", "proc"),
        ],
      ],
    },
  );
  return { ...card, ok: false };
}

/** 回调 `cb:health:retry:<模块>`：重试加载单个模块（仅全局超管）。 */
export async function moduleRetryCard(
  ctx: AdminCommandContext,
  userId: string,
  key: string,
): Promise<CardResult> {
  if (!ctx.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin)) {
    return {
      ...cardFromText("权限不足", "重试加载模块只有全局超管可以操作。", {
        rows: [[viewButton("status", "查看状态", "status", "proc")]],
      }),
      ok: false,
    };
  }
  const health = ctx.health;
  const module = health?.list().find((status) => status.key === key);
  if (!health || !module) {
    return {
      ...cardFromText("未知模块", `没有叫「${key}」的模块。`, {
        rows: [[viewButton("status", "查看状态", "status", "proc")]],
      }),
      ok: false,
    };
  }
  const status = await health.retry(module.key);
  const recovered = status.state === "ready";
  return cardFromText(
    recovered ? "模块已恢复" : "仍然不可用",
    [
      recovered
        ? `「${status.label}」已重新加载成功。`
        : `「${status.label}」重新加载仍然失败：${status.error ?? "未知错误"}`,
      "",
      ...moduleStatusLines(health, ctx.diagnostics?.migration),
    ].join("\n"),
    {
      rows: [
        [
          viewButton("status", "查看状态", "status", "proc"),
          viewButton("menu", "返回菜单", "menu", "open", "main"),
        ],
      ],
    },
  );
}

/**
 * 模块状态行（`/status proc` 与重试回执共用）。
 *
 * 只说降级与迁移问题：全部正常时给一行「全部正常」，避免刷屏。
 */
export function moduleStatusLines(
  health: HealthRegistry | undefined,
  migration: MigrationResult | undefined,
): string[] {
  const lines: string[] = ["**模块**："];
  const degraded = health?.degraded ?? [];
  if (health && degraded.length === 0) {
    lines.push(`  · 全部 ${health.list().length} 个模块正常`);
  }
  for (const status of degraded) {
    lines.push(`  · ${status.label}：初始化失败 —— ${status.error ?? "未知错误"}`);
  }
  const issues = migration?.issues ?? [];
  if (issues.length === 0) {
    lines.push("**数据迁移**：无问题");
  } else {
    lines.push("**数据迁移**：");
    for (const issue of issues) {
      lines.push(`  · ${issue.step}：${issue.error}`);
    }
  }
  return lines;
}

/** 启动报告正文（私信超管）：模块降级 + 数据迁移问题。 */
export function startupReportText(
  health: HealthRegistry,
  migration: MigrationResult | undefined,
): string {
  const degraded = health.degraded;
  return [
    degraded.length > 0
      ? `${degraded.length} 个模块启动失败，对应功能已停用：`
      : "模块全部加载正常。",
    ...(degraded.length > 0 ? ["", ...moduleStatusLines(health, undefined)] : []),
    ...(migration && migration.issues.length > 0
      ? ["", ...moduleStatusLines(undefined, migration)]
      : []),
    "",
    "修好原因后可在 `/status proc` 里点「重试加载」，不用重启。",
  ].join("\n");
}
