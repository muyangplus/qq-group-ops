import type { PermissionService } from "./permissions.js";

/**
 * 权限角色的**类型化入口**（`/perm` 与管理后台「权限」页共用）。
 *
 * 指令层接受 `super / gsuper / admin / mod` 与一批中文别名；管理 API 只接受这 4 个规范角色，
 * 两边都落到这里，保证「同一个角色 = 同一个 `PermissionService` 方法」。
 */

export type PermissionRole = "super" | "group_super" | "group_admin" | "moderator";

export const PERMISSION_ROLES: readonly PermissionRole[] = [
  "super",
  "group_super",
  "group_admin",
  "moderator",
];

export const PERMISSION_ROLE_LABELS: Record<PermissionRole, string> = {
  super: "全局超级管理员",
  group_super: "本群超级管理员",
  group_admin: "群管理员",
  moderator: "审核员",
};

/** 规范角色名 → 中文名；不认识的返回 `undefined`（调用方给「未知角色」）。 */
export function permissionRoleLabel(role: string): string | undefined {
  return PERMISSION_ROLES.includes(role as PermissionRole)
    ? PERMISSION_ROLE_LABELS[role as PermissionRole]
    : undefined;
}

/** 全局角色（`super`）不需要群；其余三个都必须带群。 */
export function isGlobalPermissionRole(role: PermissionRole): boolean {
  return role === "super";
}

export function grantPermissionRole(
  permissions: PermissionService,
  role: PermissionRole,
  groupId: string | undefined,
  userId: string,
): void {
  switch (role) {
    case "super":
      permissions.grantSuperAdmin(userId);
      return;
    case "group_super":
      permissions.grantGroupSuperAdmin(requireGroup(role, groupId), userId);
      return;
    case "group_admin":
      permissions.grantGroupAdmin(requireGroup(role, groupId), userId);
      return;
    case "moderator":
      permissions.grantModerator(requireGroup(role, groupId), userId);
      return;
  }
}

/** 撤销；返回「是否真的删掉了」——重复撤销/本来就没有时是 `false`。 */
export function revokePermissionRole(
  permissions: PermissionService,
  role: PermissionRole,
  groupId: string | undefined,
  userId: string,
): boolean {
  switch (role) {
    case "super":
      return permissions.revokeSuperAdmin(userId);
    case "group_super":
      return permissions.revokeGroupSuperAdmin(requireGroup(role, groupId), userId);
    case "group_admin":
      return permissions.revokeGroupAdmin(requireGroup(role, groupId), userId);
    case "moderator":
      return permissions.revokeModerator(requireGroup(role, groupId), userId);
  }
}

/** 某角色在某个范围内的成员（三个 list 方法统一入口）。 */
export function listPermissionRole(
  permissions: PermissionService,
  role: PermissionRole,
  groupId?: string | undefined,
): string[] {
  switch (role) {
    case "super":
      return permissions.listSuperAdmins();
    case "group_super":
      return permissions.listGroupSuperAdmins(requireGroup(role, groupId));
    case "group_admin":
      return permissions.listGroupAdmins(requireGroup(role, groupId));
    case "moderator":
      return permissions.listModerators(requireGroup(role, groupId));
  }
}

function requireGroup(role: PermissionRole, groupId: string | undefined): string {
  if (groupId === undefined || groupId.trim().length === 0) {
    throw new Error(`${PERMISSION_ROLE_LABELS[role]}需要指定群（group_openid）。`);
  }
  return groupId.trim();
}
