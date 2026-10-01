import { PermissionLevel } from "../core/enums.js";
import type { PermissionRepository } from "../db/permissionRepository.js";
import { PermissionService } from "../services/permissions.js";

/** 管理 API 视角的权限画像（E2-d 用它决定界面显示什么）。 */
export interface AdminApiPermissionsView {
  /** 平台档：`240` = 全局超管；`0` = 没有平台角色。 */
  platformLevel: number;
  /** 有权限的群（群内档 130/140，或平台档折算后的生效档）。 */
  groups: Array<{ groupId: string; level: number }>;
}

/**
 * 加载权限（管理 API 进程用）。
 *
 * 与机器人进程**共用同一套两轴模型**（`PermissionService` + `permission_grants` 表），
 * 不另造一套判据；返回 undefined 表示没有仓储（内存模式），此时端点按"无权限"处理。
 */
export async function loadAdminApiPermissions(
  repository: PermissionRepository | undefined,
  seedSuperAdminIds: readonly string[] = [],
): Promise<PermissionService | undefined> {
  if (!repository) {
    return undefined;
  }
  const permissions = new PermissionService(
    { superAdminIds: new Set(seedSuperAdminIds) },
    repository,
  );
  await permissions.load();
  return permissions;
}

/**
 * 汇总某个用户在给定群集合里的生效档位。
 *
 * **只列出能真正干事的群**（审核员 120 及以上）：普通成员是 110，列出来只会让界面噪声变大。
 * `groupIds` 由调用方从授权行与群配置里收集（API 进程没有内存态的群列表）。
 */
export function describePermissions(
  permissions: PermissionService,
  userId: string,
  groupIds: readonly string[],
): AdminApiPermissionsView {
  const groups: Array<{ groupId: string; level: number }> = [];
  for (const groupId of [...new Set(groupIds)].sort()) {
    const level = permissions.levelFor(userId, groupId);
    if (level >= PermissionLevel.Moderator) {
      groups.push({ groupId, level });
    }
  }
  return { platformLevel: permissions.globalLevelOf(userId), groups };
}
