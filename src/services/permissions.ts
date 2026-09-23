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
 * 注入仓储后：
 * - `load()` 从数据库载入全部授权；仅当数据库里没有任何超级管理员时，才用
 *   `ADMIN_USER_IDS` 作为初始种子并写回数据库；
 * - 授权 / 撤销同步更新内存，并写穿透到数据库。
 */
export class PermissionService {
  private readonly superAdminIds = new Set<string>();
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
    this.groupAdminIds.clear();
    this.moderatorIds.clear();
    for (const grant of grants) {
      this.applyGrant(grant);
    }
    const hasSuperAdmin = grants.some((grant) => grant.scope === "super_admin");
    if (!hasSuperAdmin && this.seedSuperAdminIds.size > 0) {
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

  public isSuperAdmin(userId: string): boolean {
    return this.superAdminIds.has(userId);
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
    if (grant.scope === "super_admin") {
      this.superAdminIds.add(grant.userId);
      return;
    }
    const target =
      grant.scope === "group_admin" ? this.groupAdminIds : this.moderatorIds;
    this.ensureGroupSet(grant.groupId, target).add(grant.userId);
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
