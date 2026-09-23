import { PermissionLevel } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type {
  PermissionGrant,
  PermissionRepository,
} from "../db/permissionRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

const log = getLogger("permissions");

const LEVEL_RANK: Record<PermissionLevel, number> = {
  [PermissionLevel.Guest]: 0,
  [PermissionLevel.Member]: 1,
  [PermissionLevel.Moderator]: 2,
  [PermissionLevel.GroupAdmin]: 3,
  [PermissionLevel.SuperAdmin]: 4,
};

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

  public levelFor(userId: string, groupId?: string): PermissionLevel {
    if (this.superAdminIds.has(userId)) {
      return PermissionLevel.SuperAdmin;
    }
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

  public hasAtLeast(
    userId: string,
    groupId: string | undefined,
    required: PermissionLevel,
  ): boolean {
    return LEVEL_RANK[this.levelFor(userId, groupId)] >= LEVEL_RANK[required];
  }

  public canApproveJoin(userId: string, groupId: string): boolean {
    return this.hasAtLeast(userId, groupId, PermissionLevel.GroupAdmin);
  }

  public canManageRules(userId: string, groupId: string): boolean {
    return this.hasAtLeast(userId, groupId, PermissionLevel.GroupAdmin);
  }

  public canReviewContent(userId: string, groupId: string): boolean {
    return this.hasAtLeast(userId, groupId, PermissionLevel.Moderator);
  }

  public canExportData(userId: string, groupId: string): boolean {
    return this.hasAtLeast(userId, groupId, PermissionLevel.GroupAdmin);
  }

  public hasAnyGroupRole(userId: string, required: PermissionLevel): boolean {
    const groupIds = new Set([
      ...this.groupSuperAdminIds.keys(),
      ...this.groupAdminIds.keys(),
      ...this.moderatorIds.keys(),
    ]);
    for (const groupId of groupIds) {
      if (LEVEL_RANK[this.levelFor(userId, groupId)] >= LEVEL_RANK[required]) {
        return true;
      }
    }
    return false;
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
