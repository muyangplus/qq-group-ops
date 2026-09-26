import { getLogger } from "../../core/logger.js";
import { renderCard } from "../cardTemplate.js";
import type { AdminCommandContext } from "./context.js";
import { syncCard } from "./reviewCommands.js";
import {
  type CommandResult,
  GROUP_SUPER_ROLES,
  normalize,
  PERM_USAGE,
  viewButton,
} from "./support.js";
import { resolveUserId } from "./targetResolvers.js";

/**
 * `/myperm` 与 `/perm` 域：权限查询、授予 / 撤销、列表格式化，以及 `/sync` 入口。
 */

const log = getLogger("admin-commands");

export function handleMyPermission(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
): CommandResult {
  const level = ctx.permissions.levelFor(userId, groupId);
  const scope = groupId ?? "";
  const mark = (ok: boolean): string => (ok ? "\u2713" : "\u2717");
  // 文案要求：只留两行（等级 + 能力标记），说明类文字一律进按钮 / 帮助
  const flags = [
    `审批 ${mark(ctx.permissions.canApproveJoin(userId, scope))}`,
    `规则 ${mark(ctx.permissions.canManageRules(userId, scope))}`,
    `审核 ${mark(ctx.permissions.canReviewContent(userId, scope))}`,
    `导出 ${mark(ctx.permissions.canExportData(userId, scope))}`,
    ...(ctx.permissions.isSuperAdmin(userId) ? ["配置权限 \u2713"] : []),
  ].join(" \u00b7 ");
  const scopeLabel =
    groupId && ctx.permissions.isGroupSuperAdmin(userId, groupId)
      ? "（本群超管）"
      : ctx.permissions.isSuperAdmin(userId)
        ? "（全局超管）"
        : "";
  return {
    ok: true,
    text: [`权限等级：${level}${scopeLabel}`, flags].join("\n"),
  };
}

export function handlePermissionConfig(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): CommandResult {
  if (!ctx.permissions.isSuperAdmin(userId)) {
    log.warn("permission config denied", { groupId, userId });
    return { ok: false, text: "权限不足：仅超级管理员可以配置权限。" };
  }

  const action = normalize(parts[1]);
  if (!action || action === "list" || action === "列表") {
    const targetGroupId = ctx.helpers.resolveTargetGroupId(groupId, parts[2]);
    return {
      ok: true,
      text: formatPermissionList(ctx, targetGroupId),
    };
  }

  const role = normalize(parts[2]);
  const isSuperRole = role === "super" || role === "超管";
  const isGroupSuperRole = GROUP_SUPER_ROLES.has(role);
  let targetGroupId: string | undefined;
  let targetUserId: string | undefined;

  if (isSuperRole) {
    targetUserId = resolveUserId(ctx, parts[3]);
  } else if (isGroupSuperRole) {
    targetGroupId = groupId ?? ctx.helpers.resolveTargetGroupId(undefined, parts[3]);
    targetUserId = resolveUserId(ctx, groupId ? parts[3] : parts[4]);
  } else {
    targetGroupId = ctx.helpers.resolveTargetGroupId(groupId, parts[3]);
    targetUserId = resolveUserId(ctx, groupId ? parts[3] : parts[4]);
  }

  if (!role) {
    return { ok: false, text: PERM_USAGE };
  }

  if (!isSuperRole && !targetGroupId) {
    return {
      ok: false,
      text: "私信中配置群角色需要提供群号或 #群短码。",
    };
  }

  if (!targetUserId) {
    return { ok: false, text: PERM_USAGE };
  }

  try {
    if (action === "grant" || action === "授予") {
      grantRole(ctx, targetGroupId, role, targetUserId);
    } else if (action === "revoke" || action === "撤销") {
      revokeRole(ctx, targetGroupId, role, targetUserId);
    } else {
      return { ok: false, text: PERM_USAGE };
    }
  } catch (error) {
    log.warn("permission config failed", {
      groupId,
      userId,
      action,
      role,
      targetUserId,
      error: String(error),
    });
    return { ok: false, text: `权限配置失败：${String(error)}` };
  }

  log.info("permission config updated", {
    groupId: targetGroupId,
    userId,
    action,
    role,
    targetUserId,
  });
  return {
    ok: true,
    text: `已更新权限：${role} ${ctx.helpers.displayUser(targetUserId)}\n\n${formatPermissionList(ctx, targetGroupId)}`,
  };
}

export function formatPermissionList(ctx: AdminCommandContext, groupId?: string): string {
  const lines = [`全局超级管理员：${ctx.helpers.displayUsers(ctx.permissions.listSuperAdmins())}`];
  if (groupId) {
    const label = ctx.helpers.displayGroup(groupId);
    lines.push(
      `本群超级管理员（${label}）：${ctx.helpers.displayUsers(ctx.permissions.listGroupSuperAdmins(groupId))}`,
    );
    lines.push(
      `群管理员（${label}）：${ctx.helpers.displayUsers(ctx.permissions.listGroupAdmins(groupId))}`,
    );
    lines.push(
      `审核员（${label}）：${ctx.helpers.displayUsers(ctx.permissions.listModerators(groupId))}`,
    );
  } else {
    lines.push("本群超级管理员：私信中请指定 group_openid");
    lines.push("群管理员：私信中请指定 group_openid");
    lines.push("审核员：私信中请指定 group_openid");
  }
  return lines.join("\n");
}

export function grantRole(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  role: string,
  targetUserId: string,
): void {
  if (role === "super" || role === "超管") {
    ctx.permissions.grantSuperAdmin(targetUserId);
    return;
  }
  if (!groupId) {
    throw new Error("group_openid is required");
  }
  if (GROUP_SUPER_ROLES.has(role)) {
    ctx.permissions.grantGroupSuperAdmin(groupId, targetUserId);
    return;
  }
  if (role === "admin" || role === "管理员") {
    ctx.permissions.grantGroupAdmin(groupId, targetUserId);
    return;
  }
  if (role === "mod" || role === "审核员") {
    ctx.permissions.grantModerator(groupId, targetUserId);
    return;
  }
  throw new Error(`未知角色：${role}`);
}

export function revokeRole(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  role: string,
  targetUserId: string,
): void {
  if (role === "super" || role === "超管") {
    ctx.permissions.revokeSuperAdmin(targetUserId);
    return;
  }
  if (!groupId) {
    throw new Error("group_openid is required");
  }
  if (GROUP_SUPER_ROLES.has(role)) {
    ctx.permissions.revokeGroupSuperAdmin(groupId, targetUserId);
    return;
  }
  if (role === "admin" || role === "管理员") {
    ctx.permissions.revokeGroupAdmin(groupId, targetUserId);
    return;
  }
  if (role === "mod" || role === "审核员") {
    ctx.permissions.revokeModerator(groupId, targetUserId);
    return;
  }
  throw new Error(`未知角色：${role}`);
}

export async function handleSync(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const targetGroupId = ctx.helpers.resolveTargetGroupId(groupId, parts[1]);
  if (!targetGroupId) {
    const card = renderCard({
      title: "同步官方申请",
      lines: [
        "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
        "用法：/sync [#群短码|群号]",
      ],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  return syncCard(ctx, targetGroupId, userId, groupId);
}
