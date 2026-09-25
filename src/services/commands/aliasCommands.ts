import { CLASS_ALIAS_KIND_LABELS } from "../classAliases.js";
import type { AdminCommandContext } from "./context.js";
import { ALIAS_USAGE, formatError, normalize, type CommandResult } from "./support.js";

/**
 * `/alias` 领域模块：班级 / 学院 / 专业别名表（仅全局超级管理员可维护）。
 *
 * 依赖通过 `AdminCommandContext` 显式传入，便于单独测试与复用。
 */
export function aliasCard(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
): CommandResult {
  const aliases = ctx.classAliases;
  if (!aliases) {
    return { ok: false, text: "别名表未启用。" };
  }
  if (!ctx.permissions.isSuperAdmin(userId)) {
    return { ok: false, text: "权限不足：仅全局超级管理员可以维护别名表。" };
  }
  const action = normalize(parts[1]);
  if (!action || action === "list" || action === "列表" || action === "查看") {
    const entries = aliases.list();
    if (entries.length === 0) {
      return { ok: true, text: `别名表为空。\n\n${ALIAS_USAGE}` };
    }
    const lines = [`别名表（共 ${entries.length} 条）：`];
    for (const entry of entries) {
      lines.push(
        `  ${entry.alias} → ${entry.target}（${CLASS_ALIAS_KIND_LABELS[entry.kind]}）`,
      );
    }
    lines.push("", ALIAS_USAGE);
    return { ok: true, text: lines.join("\n") };
  }
  if (
    action === "set" ||
    action === "设置" ||
    action === "add" ||
    action === "添加"
  ) {
    const alias = parts[2]?.trim();
    const target = parts.slice(3).join(" ").trim();
    if (!alias || !target) {
      return { ok: false, text: ALIAS_USAGE };
    }
    try {
      const entry = aliases.set(alias, target);
      return {
        ok: true,
        text:
          `已保存别名：${entry.alias} → ${entry.target}` +
          `（${CLASS_ALIAS_KIND_LABELS[entry.kind]}）\n\n${ALIAS_USAGE}`,
      };
    } catch (error) {
      return { ok: false, text: `保存失败：${formatError(error)}` };
    }
  }
  if (
    action === "del" ||
    action === "delete" ||
    action === "remove" ||
    action === "删除"
  ) {
    const alias = parts.slice(2).join(" ").trim();
    if (!alias) {
      return { ok: false, text: ALIAS_USAGE };
    }
    return aliases.remove(alias)
      ? { ok: true, text: `已删除别名：${alias}\n\n${ALIAS_USAGE}` }
      : { ok: false, text: `别名「${alias}」不存在。\n\n${ALIAS_USAGE}` };
  }
  return { ok: false, text: ALIAS_USAGE };
}
