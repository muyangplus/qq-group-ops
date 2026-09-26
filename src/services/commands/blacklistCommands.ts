import type { BlacklistScope } from "../../db/blacklistRepository.js";
import type { CardButton } from "../cardTemplate.js";
import type { AdminCommandContext } from "./context.js";
import { resolveUserId } from "./targetResolvers.js";
import {
  cardFromText,
  formatError,
  formatTime,
  isGlobalTarget,
  normalize,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

/**
 * `/blacklist` 领域模块（§A5）。
 *
 * - **本群黑名单**：审核员及以上可增删（命中后该群入群申请直接拒绝、已在群内踢出）；
 * - **全局黑名单**：仅全局超管可增删（影响机器人**所有已绑定群**）。
 *
 * 列表卡每页 4 条，每条一个「解除N」回调按钮（二次确认），切换作用域与翻页也是回调。
 */

const PAGE_SIZE = 4;

export interface BlacklistViewInput {
  scope: BlacklistScope;
  /** `scope=group` 时的群；全局传空串。 */
  groupId: string;
  page: number;
  notice?: string | undefined;
}

export const BLACKLIST_USAGE = [
  "用法：",
  "  /blacklist                            查看黑名单（群内=本群；私信=全局）",
  "  /blacklist list 全局 [+页码]           查看全局黑名单",
  "  /blacklist add <QQ号|#短码> [原因]      加入本群黑名单（群内使用）",
  "  /blacklist add 全局 <QQ号|#短码> [原因] 加入全局黑名单（仅全局超管）",
  "  /blacklist del <QQ号|#短码> [全局]      解除黑名单",
].join("\n");

/** 黑名单列表卡。 */
export function blacklistCard(
  ctx: AdminCommandContext,
  options: BlacklistViewInput,
  viewerId: string,
): CardResult {
  const blacklist = ctx.blacklist;
  if (!blacklist) {
    return cardFromText("黑名单", "黑名单服务未启用。");
  }
  const allowed =
    options.scope === "global"
      ? ctx.permissions.isSuperAdmin(viewerId)
      : options.groupId.length > 0 &&
        ctx.permissions.canReviewContent(viewerId, options.groupId);
  if (!allowed) {
    const card = cardFromText(
      "黑名单",
      options.scope === "global"
        ? "权限不足：全局黑名单仅超级管理员可操作。"
        : "权限不足：本群黑名单需要审核员或以上权限。",
    );
    return { ok: false, text: card.text, rich: card.rich };
  }

  const entries =
    options.scope === "global"
      ? blacklist.globalEntries()
      : blacklist.entriesForGroup(options.groupId);
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page), totalPages);
  const slice = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const scopeLabel =
    options.scope === "global"
      ? "全局（所有绑定群）"
      : `本群 ${ctx.helpers.groupLabel(options.groupId)}`;
  const lines = [
    ...ctx.helpers.renderNotice(options.notice),
    `**作用范围**：${scopeLabel}`,
    `**条目数**：共 ${entries.length} 条 · 第 ${page} / ${totalPages} 页`,
  ];
  if (slice.length === 0) {
    lines.push("", "（空）");
  } else {
    lines.push("");
    slice.forEach((entry, index) => {
      const serial = (page - 1) * PAGE_SIZE + index + 1;
      lines.push(
        `${serial}. ${ctx.helpers.displayUser(entry.userId)}` +
          `（${entry.reason || "未填原因"}）` +
          ` — ${ctx.helpers.displayUser(entry.actorId)} @ ${formatTime(entry.createdAt)}`,
      );
    });
  }
  lines.push(
    "",
    options.scope === "global"
      ? "全局黑名单会在所有绑定群拒绝其入群申请，并在其已在群内时踢出。"
      : "本群黑名单会拒绝其入群申请；已在群内则由「加入」动作踢出。",
  );

  const rows: CardButton[][] = [];
  const switches: CardButton[] = [];
  if (options.groupId.length > 0) {
    switches.push(
      viewButton(
        "groupScope",
        `本群 ${entries.length}`,
        "blacklist",
        "scope",
        "group",
        options.groupId,
        1,
      ),
    );
  }
  switches.push(
    viewButton(
      "globalScope",
      `全局 ${blacklist.globalEntries().length}`,
      "blacklist",
      "scope",
      "global",
      "",
      1,
    ),
  );
  switches.push(
    viewButton(
      "refresh",
      "刷新",
      "blacklist",
      "scope",
      options.scope,
      options.groupId,
      page,
    ),
  );
  rows.push(switches);

  if (slice.length > 0) {
    rows.push(
      slice.map((entry, index) =>
        viewButton(
          `del-${index}`,
          `解除${index + 1}`,
          "blacklist",
          "del",
          options.scope,
          options.groupId,
          entry.userId,
          page,
        ),
      ),
    );
  }
  if (totalPages > 1) {
    const nav: CardButton[] = [];
    if (page > 1) {
      nav.push(
        viewButton(
          "prev",
          "上一页",
          "blacklist",
          "scope",
          options.scope,
          options.groupId,
          page - 1,
        ),
      );
    }
    if (page < totalPages) {
      nav.push(
        viewButton(
          "next",
          "下一页",
          "blacklist",
          "scope",
          options.scope,
          options.groupId,
          page + 1,
        ),
      );
    }
    rows.push(nav);
  }

  return cardFromText("黑名单", lines.join("\n"), {
    rows,
    footer: ["解除按钮带二次确认。", BLACKLIST_USAGE],
  });
}

/** 回调：切换作用域 / 翻页。 */
export function blacklistScopeCard(
  ctx: AdminCommandContext,
  input: { scope: string; groupId: string; page: number; viewerId: string },
): CardResult {
  const scope: BlacklistScope = input.scope === "global" ? "global" : "group";
  return blacklistCard(
    ctx,
    {
      scope,
      groupId: scope === "global" ? "" : input.groupId,
      page: input.page,
    },
    input.viewerId,
  );
}

/** 回调：解除一条黑名单（带二次确认弹窗的按钮触发）。 */
export async function blacklistDeleteCard(
  ctx: AdminCommandContext,
  input: {
    scope: string;
    groupId: string;
    targetUserId: string;
    page: number;
    viewerId: string;
    replyGroupId?: string | undefined;
  },
): Promise<CardResult> {
  const scope: BlacklistScope = input.scope === "global" ? "global" : "group";
  if (!ctx.blacklist) {
    return cardFromText("黑名单", "黑名单服务未启用。");
  }
  if (scope === "global" && !ctx.permissions.isSuperAdmin(input.viewerId)) {
    const card = cardFromText("黑名单", "权限不足：全局黑名单仅超级管理员可操作。");
    return { ok: false, text: card.text, rich: card.rich };
  }
  if (
    scope === "group" &&
    !ctx.permissions.canReviewContent(input.viewerId, input.groupId)
  ) {
    const card = cardFromText("黑名单", "权限不足：本群黑名单需要审核员或以上权限。");
    return { ok: false, text: card.text, rich: card.rich };
  }
  try {
    const removed = await ctx.blacklist.remove(
      scope,
      scope === "global" ? "" : input.groupId,
      input.targetUserId,
    );
    const notice = `${ctx.helpers.mention(input.replyGroupId, input.viewerId)}${
      removed ? "已解除黑名单。" : "该成员本来就不在黑名单里。"
    }`;
    return blacklistCard(
      ctx,
      {
        scope,
        groupId: scope === "global" ? "" : input.groupId,
        page: input.page,
        notice,
      },
      input.viewerId,
    );
  } catch (error) {
    return blacklistCard(
      ctx,
      {
        scope,
        groupId: scope === "global" ? "" : input.groupId,
        page: input.page,
        notice: `${ctx.helpers.mention(input.replyGroupId, input.viewerId)}解除失败：${formatError(error)}`,
      },
      input.viewerId,
    );
  }
}

/** `/blacklist ...` 指令入口。 */
export async function handleBlacklist(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const action = normalize(parts[1]);
  if (!ctx.blacklist) {
    return { ok: false, text: "黑名单服务未启用。" };
  }

  // /blacklist [list] [全局] [+页码]
  if (!action || action === "list" || action === "列表") {
    const scope =
      isGlobalTarget(parts[1]) || isGlobalTarget(parts[2])
        ? "global"
        : groupId
          ? "group"
          : "global";
    const pageToken = parts.find((part) => /^\+\d+$/u.test(part));
    const page = pageToken ? Number.parseInt(pageToken.slice(1), 10) : 1;
    return blacklistCard(
      ctx,
      {
        scope,
        groupId: scope === "global" ? "" : (groupId ?? ""),
        page,
      },
      userId,
    );
  }

  if (action === "add" || action === "添加") {
    const globalWord = isGlobalTarget(parts[2]);
    const scope: BlacklistScope = globalWord ? "global" : "group";
    if (scope === "group" && !groupId) {
      return { ok: false, text: `本群黑名单需要在群内添加。\n\n${BLACKLIST_USAGE}` };
    }
    const targetGroupId = scope === "global" ? "" : (groupId ?? "");
    const userRaw = globalWord ? parts[3] : parts[2];
    const targetUserId = resolveUserId(ctx, userRaw);
    if (!targetUserId) {
      return { ok: false, text: BLACKLIST_USAGE };
    }
    if (scope === "global" && !ctx.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：全局黑名单仅超级管理员可操作。" };
    }
    if (
      scope === "group" &&
      !ctx.permissions.canReviewContent(userId, targetGroupId)
    ) {
      return { ok: false, text: "权限不足：本群黑名单需要审核员或以上权限。" };
    }
    const reason = (globalWord ? parts.slice(4) : parts.slice(3)).join(" ");
    const result = await ctx.blacklist.add({
      scope,
      groupId: targetGroupId,
      userId: targetUserId,
      actorId: userId,
      reason,
      source: "manual",
    });
    return blacklistCard(
      ctx,
      {
        scope,
        groupId: targetGroupId,
        page: 1,
        notice: `${ctx.helpers.mention(groupId, userId)}${result.detail}`,
      },
      userId,
    );
  }

  if (
    action === "del" ||
    action === "delete" ||
    action === "remove" ||
    action === "删除" ||
    action === "解除"
  ) {
    const globalWord = isGlobalTarget(parts[2]) || isGlobalTarget(parts[3]);
    const scope: BlacklistScope = globalWord ? "global" : "group";
    if (scope === "group" && !groupId) {
      return { ok: false, text: `本群黑名单需要在群内解除。\n\n${BLACKLIST_USAGE}` };
    }
    const userRaw = isGlobalTarget(parts[2]) ? parts[3] : parts[2];
    const targetUserId = resolveUserId(ctx, userRaw);
    if (!targetUserId) {
      return { ok: false, text: BLACKLIST_USAGE };
    }
    const targetGroupId = scope === "global" ? "" : (groupId ?? "");
    if (scope === "global" && !ctx.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：全局黑名单仅超级管理员可操作。" };
    }
    if (
      scope === "group" &&
      !ctx.permissions.canReviewContent(userId, targetGroupId)
    ) {
      return { ok: false, text: "权限不足：本群黑名单需要审核员或以上权限。" };
    }
    const removed = await ctx.blacklist.remove(scope, targetGroupId, targetUserId);
    return blacklistCard(
      ctx,
      {
        scope,
        groupId: targetGroupId,
        page: 1,
        notice: `${ctx.helpers.mention(groupId, userId)}${
          removed ? "已解除黑名单。" : "该成员本来就不在黑名单里。"
        }`,
      },
      userId,
    );
  }

  return { ok: false, text: BLACKLIST_USAGE };
}

