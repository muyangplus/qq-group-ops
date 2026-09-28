import {
  PermissionLevel,
  PLATFORM_LEVEL_MIN,
  PLATFORM_OFFSET,
  PlatformLevel,
  type GroupLevel,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type {
  PermissionGrant,
  PermissionRepository,
} from "../db/permissionRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

const log = getLogger("permissions");

export interface PermissionPolicy {
  superAdminIds?: ReadonlySet<string>;
  groupSuperAdminIds?: ReadonlyMap<string, ReadonlySet<string>>;
  groupAdminIds?: ReadonlyMap<string, ReadonlySet<string>>;
  moderatorIds?: ReadonlyMap<string, ReadonlySet<string>>;
}

export class PermissionDeniedError extends Error {
  public constructor(message = "permission denied") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/**
 * 权限模型。
 *
 * 分两个层级：
 * - **全局超级管理员**：`ADMIN_USER_IDS` 种子或 `/perm grant super`，可管理平台级能力
 *   （`/perm`、`/rules all`、`/bind user`、`/bind groupid`、`/whois`）；
 * - **本群超级管理员**：`/perm grant gsuper`，只在被授权的群内等价于 `SuperAdmin`，
 *   拿不到任何跨群或平台级能力。
 *
 * 注入仓储后：
 * - `load()` 从数据库载入全部授权；仅当数据库里没有任何**全局**超级管理员时，才用
 *   `ADMIN_USER_IDS` 作为初始种子并写回数据库；
 * - 授权 / 撤销同步更新内存，并写穿透到数据库；
 * - 本群超级管理员复用 `scope = super_admin` + 非空 `group_id` 存储，无需改表结构。
 */
export class PermissionService {
  private readonly superAdminIds = new Set<string>();
  private readonly groupSuperAdminIds = new Map<string, Set<string>>();
  private readonly groupAdminIds = new Map<string, Set<string>>();
  private readonly moderatorIds = new Map<string, Set<string>>();
  private readonly seedSuperAdminIds: ReadonlySet<string>;
  private readonly repository: PermissionRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(
    policy: PermissionPolicy = {},
    repository?: PermissionRepository,
    queue?: WriteQueue,
  ) {
    for (const userId of policy.superAdminIds ?? []) {
      this.superAdminIds.add(userId);
    }
    for (const [groupId, userIds] of policy.groupSuperAdminIds ?? []) {
      this.groupSuperAdminIds.set(groupId, new Set(userIds));
    }
    for (const [groupId, userIds] of policy.groupAdminIds ?? []) {
      this.groupAdminIds.set(groupId, new Set(userIds));
    }
    for (const [groupId, userIds] of policy.moderatorIds ?? []) {
      this.moderatorIds.set(groupId, new Set(userIds));
    }
    this.seedSuperAdminIds = new Set(policy.superAdminIds ?? []);
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const grants = await this.repository.findAll();
    this.superAdminIds.clear();
    this.groupSuperAdminIds.clear();
    this.groupAdminIds.clear();
    this.moderatorIds.clear();
    for (const grant of grants) {
      this.applyGrant(grant);
    }
    const hasGlobalSuperAdmin = grants.some(
      (grant) => grant.scope === "super_admin" && grant.groupId === "",
    );
    if (!hasGlobalSuperAdmin && this.seedSuperAdminIds.size > 0) {
      log.info("seeding super admins from configuration", {
        count: this.seedSuperAdminIds.size,
      });
      for (const userId of this.seedSuperAdminIds) {
        this.superAdminIds.add(userId);
        this.enqueueSave({ scope: "super_admin", groupId: "", userId });
      }
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  /**
   * 生效的**群内**等级 = `max(群内档, 平台档 - PLATFORM_OFFSET)`（展示与群内判定用）。
   *
   * 例：全局超管 240 → 折算 140 = 本群超管；全局审核员 220 → 120 = 审核员。
   * 平台级判定不看它（用 `meetsGlobal`）。
   */
  public levelFor(userId: string, groupId?: string): PermissionLevel {
    const platform = this.globalLevelOf(userId);
    const folded =
      platform >= PLATFORM_LEVEL_MIN ? platform - PLATFORM_OFFSET : 0;
    return Math.max(this.groupLevelOf(userId, groupId), folded);
  }

  /** 只看**群内**角色（不折算平台档）：0 / 110 / 120 / 130 / 140。 */
  public groupLevelOf(userId: string, groupId?: string): GroupLevel {
    if (!groupId) {
      return PermissionLevel.Guest;
    }
    if (this.groupSuperAdminIds.get(groupId)?.has(userId)) {
      return PermissionLevel.SuperAdmin;
    }
    if (this.groupAdminIds.get(groupId)?.has(userId)) {
      return PermissionLevel.GroupAdmin;
    }
    if (this.moderatorIds.get(groupId)?.has(userId)) {
      return PermissionLevel.Moderator;
    }
    return PermissionLevel.Member;
  }

  /**
   * 群内判定：`max(群内档, 平台档 - PLATFORM_OFFSET)`。
   *
   * 例：全局审核员 220 + 群内管理员 130 → max(130, 120) = 130，不会压过本群超管 140。
   * 平台级能力**不要**用它，用 `meetsGlobal`。
   */
  public meetsInGroup(
    userId: string,
    groupId: string | undefined,
    required: GroupLevel,
  ): boolean {
    return this.levelFor(userId, groupId) >= required;
  }

  /** 只取全局档：平台角色按其档位，无平台角色为 0（不看任何群内角色）。 */
  public globalLevelOf(userId: string): PlatformLevel | 0 {
    return this.superAdminIds.has(userId)
      ? PlatformLevel.GlobalSuperAdmin
      : 0;
  }

  /**
   * 平台级判定（唯一入口）：`/whois`、`/perm`、全局规则 / 黑名单、`/bind groupid` …
   *
   * **只看平台档，不做折算**（参数类型 `PlatformLevel` 200..299，传群内档位编译不过；
   * 运行期再挡一层 `required < PLATFORM_LEVEL_MIN`）。
   */
  public meetsGlobal(userId: string, required: PlatformLevel): boolean {
    if (required < PLATFORM_LEVEL_MIN) {
      throw new Error(
        `平台级门槛必须 >= ${PLATFORM_LEVEL_MIN}（收到 ${required}）；群内档位请用 meetsInGroup`,
      );
    }
    return this.globalLevelOf(userId) >= required;
  }

  /**
   * 「在**任意**群里达到某等级」。
   *
   * 用于「全部群」语义（例如通知订阅选「全部群」时要求「我至少在某个群有这个角色」），
   * 与 `meetsInGroup(user, group, level)`（某一个群）区分开。
   */
  public meetsAnywhere(userId: string, required: GroupLevel): boolean {
    const groupIds = new Set([
      ...this.groupSuperAdminIds.keys(),
      ...this.groupAdminIds.keys(),
      ...this.moderatorIds.keys(),
    ]);
    for (const groupId of groupIds) {
      if (this.meetsInGroup(userId, groupId, required)) {
        return true;
      }
    }
    return false;
  }

  /** 该用户能审批入群申请的群列表（全局超管对任何群都可审批，这里只返回已授权过的群）。 */
  public listReviewableGroups(userId: string): string[] {
    const groupIds = new Set([
      ...this.groupSuperAdminIds.keys(),
      ...this.groupAdminIds.keys(),
      ...this.moderatorIds.keys(),
    ]);
    return [...groupIds]
      .filter((groupId) =>
        this.meetsInGroup(userId, groupId, PermissionLevel.GroupAdmin),
      )
      .sort();
  }

  /** 该用户有内容审核权限（审核员及以上）的群列表。 */
  public listModeratedGroups(userId: string): string[] {
    const groupIds = new Set([
      ...this.groupSuperAdminIds.keys(),
      ...this.groupAdminIds.keys(),
      ...this.moderatorIds.keys(),
    ]);
    return [...groupIds]
      .filter((groupId) =>
        this.meetsInGroup(userId, groupId, PermissionLevel.Moderator),
      )
      .sort();
  }

  /** 全局超级管理员：可管理平台级能力。 */
  public isSuperAdmin(userId: string): boolean {
    return this.superAdminIds.has(userId);
  }

  /** 本群超级管理员：仅在被授权的群内拥有最高权限。 */
  public isGroupSuperAdmin(userId: string, groupId: string): boolean {
    if (!groupId) {
      return false;
    }
    return this.groupSuperAdminIds.get(groupId)?.has(userId) ?? false;
  }

  public grantSuperAdmin(userId: string): void {
    this.superAdminIds.add(userId);
    this.enqueueSave({ scope: "super_admin", groupId: "", userId });
  }

  public revokeSuperAdmin(userId: string): boolean {
    if (this.superAdminIds.size <= 1 && this.superAdminIds.has(userId)) {
      throw new Error("cannot revoke the last super admin");
    }
    const removed = this.superAdminIds.delete(userId);
    if (removed) {
      this.enqueueRemove({ scope: "super_admin", groupId: "", userId });
    }
    return removed;
  }

  public grantGroupSuperAdmin(groupId: string, userId: string): void {
    this.ensureGroupSet(groupId, this.groupSuperAdminIds).add(userId);
    this.enqueueSave({ scope: "super_admin", groupId, userId });
  }

  public revokeGroupSuperAdmin(groupId: string, userId: string): boolean {
    const removed =
      this.groupSuperAdminIds.get(groupId)?.delete(userId) ?? false;
    if (removed) {
      this.enqueueRemove({ scope: "super_admin", groupId, userId });
    }
    return removed;
  }

  public grantGroupAdmin(groupId: string, userId: string): void {
    this.ensureGroupSet(groupId, this.groupAdminIds).add(userId);
    this.enqueueSave({ scope: "group_admin", groupId, userId });
  }

  public revokeGroupAdmin(groupId: string, userId: string): boolean {
    const removed = this.groupAdminIds.get(groupId)?.delete(userId) ?? false;
    if (removed) {
      this.enqueueRemove({ scope: "group_admin", groupId, userId });
    }
    return removed;
  }

  public grantModerator(groupId: string, userId: string): void {
    this.ensureGroupSet(groupId, this.moderatorIds).add(userId);
    this.enqueueSave({ scope: "moderator", groupId, userId });
  }

  public revokeModerator(groupId: string, userId: string): boolean {
    const removed = this.moderatorIds.get(groupId)?.delete(userId) ?? false;
    if (removed) {
      this.enqueueRemove({ scope: "moderator", groupId, userId });
    }
    return removed;
  }

  public listSuperAdmins(): string[] {
    return [...this.superAdminIds].sort();
  }

  public listGroupSuperAdmins(groupId: string): string[] {
    return [...(this.groupSuperAdminIds.get(groupId) ?? [])].sort();
  }

  public listGroupAdmins(groupId: string): string[] {
    return [...(this.groupAdminIds.get(groupId) ?? [])].sort();
  }

  public listModerators(groupId: string): string[] {
    return [...(this.moderatorIds.get(groupId) ?? [])].sort();
  }

  public ensure(allowed: boolean, message = "permission denied"): void {
    if (!allowed) {
      throw new PermissionDeniedError(message);
    }
  }

  private applyGrant(grant: PermissionGrant): void {
    switch (grant.scope) {
      case "super_admin":
        // groupId 为空 = 全局超级管理员；非空 = 本群超级管理员
        if (grant.groupId) {
          this.ensureGroupSet(grant.groupId, this.groupSuperAdminIds).add(
            grant.userId,
          );
        } else {
          this.superAdminIds.add(grant.userId);
        }
        return;
      case "group_admin":
        this.ensureGroupSet(grant.groupId, this.groupAdminIds).add(grant.userId);
        return;
      case "moderator":
        this.ensureGroupSet(grant.groupId, this.moderatorIds).add(grant.userId);
        return;
    }
  }

  private enqueueSave(grant: PermissionGrant): void {
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("permissions.save", () => repository.save(grant));
    }
  }

  private enqueueRemove(grant: PermissionGrant): void {
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("permissions.remove", () => repository.remove(grant));
    }
  }

  private ensureGroupSet(
    groupId: string,
    target: Map<string, Set<string>>,
  ): Set<string> {
    let set = target.get(groupId);
    if (!set) {
      set = new Set();
      target.set(groupId, set);
    }
    return set;
  }
}
