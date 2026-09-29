import { randomUUID } from "node:crypto";

import { AuditStatus, PlatformLevel } from "../../core/enums.js";
import { CARD_MAX_ROWS } from "../cardTemplate.js";
import type { SettingView } from "../platformSettings.js";
import type { AdminCommandContext } from "./context.js";
import {
  actionButton,
  cardFromText,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

/** 每页可放的项数：每行 2 个「填入指令」按钮，留 1 行翻页 / 返回。 */
const ITEMS_PER_PAGE = (CARD_MAX_ROWS - 1) * 2;

function denied(title: string, text: string): CardResult {
  return {
    ...cardFromText(title, text, {
      rows: [[viewButton("menu", "返回菜单", "menu", "open", "main")]],
    }),
    ok: false,
  };
}

/** 权限 / 私信 / 存储三项前置检查；返回拒绝卡表示不能继续。 */
function guard(
  ctx: AdminCommandContext,
  userId: string,
  groupId: string | undefined,
): CardResult | undefined {
  if (!ctx.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin)) {
    return denied("权限不足", "平台配置只有全局超管可以查看和修改。");
  }
  if (groupId !== undefined) {
    return denied(
      "请在私信中执行",
      "平台配置**只能在私信里**改：请私信机器人发送 /config。",
    );
  }
  if (!ctx.platform) {
    return denied(
      "配置不可用",
      "当前进程没有装配平台配置存储（纯测试环境或直接导入服务层调用时如此）。",
    );
  }
  return undefined;
}

function sourceLabel(view: SettingView): string {
  return view.source === "override" ? "**已覆盖**" : "`.env` 默认";
}

/**
 * `/config`：平台热配置面板（**仅全局超管、只在私信**）。
 *
 * 卡片键盘打不了自由文本，所以每项只给「填入指令」按钮，数值由超管自己敲；
 * 改完**立即生效**，不需要重启。
 */
export function configPanelCard(
  ctx: AdminCommandContext,
  userId: string,
  page = 1,
  notice?: string,
): CardResult {
  const blocked = guard(ctx, userId, undefined);
  if (blocked) {
    return blocked;
  }
  const platform = ctx.platform!;
  const views = platform.list();
  const pageCount = Math.max(1, Math.ceil(views.length / ITEMS_PER_PAGE));
  const current = Math.min(Math.max(1, page), pageCount);
  const visible = views.slice(
    (current - 1) * ITEMS_PER_PAGE,
    current * ITEMS_PER_PAGE,
  );
  const lines = [...ctx.helpers.renderNotice(notice)];
  for (const view of visible) {
    lines.push(
      `- **${view.definition.label}**（\`${view.definition.key}\`）：${
        view.definition.describe(view.value)
      } · ${sourceLabel(view)}`,
    );
  }
  lines.push(
    "",
    "改法：点「填入指令」后补数值发送，或直接发 `/config set <项> <值>`；",
    "想回落到 `.env` 默认值就发 `/config clear <项>`。改完**立即生效**，不用重启。",
  );
  if (platform.issues.length > 0) {
    lines.push("", "⚠️ 库里有读不出来的覆盖值（已忽略，按 `.env` 默认跑）：");
    for (const issue of platform.issues) {
      lines.push(`  · ${issue}`);
    }
  }

  const rows = [];
  for (let index = 0; index < visible.length; index += 2) {
    rows.push(
      visible.slice(index, index + 2).map((view) =>
        actionButton(
          `${view.definition.key}Set`,
          `${view.definition.short}改`,
          `/config set ${view.definition.key} `,
          { fillOnly: true },
        ),
      ),
    );
  }
  const nav = [];
  if (current > 1) {
    nav.push(viewButton("prev", "上一页", "config", "view", current - 1));
  }
  if (current < pageCount) {
    nav.push(viewButton("next", "下一页", "config", "view", current + 1));
  }
  nav.push(viewButton("menu", "返回菜单", "menu", "open", "main"));
  rows.push(nav);
  return cardFromText(
    pageCount > 1 ? `平台配置（${current}/${pageCount}）` : "平台配置",
    lines.join("\n"),
    { rows },
  );
}

/** `/config`、`/config set <项> <值>`、`/config clear <项>`。 */
export function handleConfig(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): CommandResult | Promise<CommandResult> {
  const blocked = guard(ctx, userId, groupId);
  if (blocked) {
    return { ok: false, text: blocked.text, rich: blocked.rich };
  }
  const action = (parts[1] ?? "").trim().toLowerCase();
  if (action === "" || action === "list" || action === "列表") {
    return configPanelCard(ctx, userId, 1);
  }
  const clearing = action === "clear" || action === "清";
  if (!clearing && action !== "set" && action !== "改") {
    return configPanelCard(
      ctx,
      userId,
      1,
      `未识别的动作「${parts[1]}」：用法是 /config、/config set <项> <值>、/config clear <项>。`,
    );
  }
  const key = (parts[2] ?? "").trim();
  if (key === "") {
    return configPanelCard(ctx, userId, 1, "要写清改哪一项：/config set <项> <值>。");
  }
  if (clearing) {
    return clearSetting(ctx, userId, key);
  }
  const value = parts.slice(3).join(" ").trim();
  if (value === "") {
    return configPanelCard(ctx, userId, 1, `要写新值：/config set ${key} <值>。`);
  }
  return setSetting(ctx, userId, key, value);
}

async function setSetting(
  ctx: AdminCommandContext,
  userId: string,
  key: string,
  value: string,
): Promise<CommandResult> {
  const platform = ctx.platform!;
  const result = await platform.set(key, value);
  if (!result.ok) {
    return {
      ok: false,
      text: result.error,
      rich: configPanelCard(ctx, userId, 1, `没改：${result.error}`).rich,
    };
  }
  writeAudit(ctx, userId, "platform_config_set", `${key}=${String(result.view.value)}`);
  return configPanelCard(
    ctx,
    userId,
    1,
    `已把「${result.view.definition.label}」改成 ${result.view.definition.describe(
      result.view.value,
    )}（立即生效）。`,
  );
}

async function clearSetting(
  ctx: AdminCommandContext,
  userId: string,
  key: string,
): Promise<CommandResult> {
  const platform = ctx.platform!;
  const definition = platform.list().find((view) => view.definition.key === key);
  const result = await platform.clear(key);
  if (!result.ok) {
    return {
      ok: false,
      text: result.error ?? "没改成功",
      rich: configPanelCard(ctx, userId, 1, `没改：${result.error ?? ""}`).rich,
    };
  }
  writeAudit(ctx, userId, "platform_config_clear", key);
  return configPanelCard(
    ctx,
    userId,
    1,
    `已把「${definition?.definition.label ?? key}」回落到 \`.env\` 默认值。`,
  );
}

/** 平台级改动都写审计（不挂在任何群上）。 */
function writeAudit(
  ctx: AdminCommandContext,
  userId: string,
  action: string,
  reason: string,
): void {
  ctx.auditLog.append({
    recordId: randomUUID(),
    groupId: "",
    actorId: userId,
    action,
    status: AuditStatus.Executed,
    reason,
    createdAt: new Date(),
  });
}
