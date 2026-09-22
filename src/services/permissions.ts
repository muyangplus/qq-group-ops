import { PermissionLevel } from "../core/enums.js";

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

export class PermissionService {
  private readonly superAdminIds = new Set<string>();
  private readonly groupAdminIds = new Map<string, Set<string>>();
  private readonly moderatorIds = new Map<string, Set<string>>();

  public constructor(policy: PermissionPolicy = {}) {
    for (const userId of policy.superAdminIds ?? []) {
      this.superAdminIds.add(userId);
    }
    for (const [groupId, userIds] of policy.groupAdminIds ?? []) {
      this.groupAdminIds.set(groupId, new Set(userIds));
    }
    for (const [groupId, userIds] of policy.moderatorIds ?? []) {
      this.moderatorIds.set(groupId, new Set(userIds));
    }
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
  }

  public revokeSuperAdmin(userId: string): boolean {
    if (this.superAdminIds.size <= 1 && this.superAdminIds.has(userId)) {
      throw new Error("cannot revoke the last super admin");
    }
    return this.superAdminIds.delete(userId);
  }

  public grantGroupAdmin(groupId: string, userId: string): void {
    this.ensureGroupSet(groupId, this.groupAdminIds).add(userId);
  }

  public revokeGroupAdmin(groupId: string, userId: string): boolean {
    return this.groupAdminIds.get(groupId)?.delete(userId) ?? false;
  }

  public grantModerator(groupId: string, userId: string): void {
    this.ensureGroupSet(groupId, this.moderatorIds).add(userId);
  }

  public revokeModerator(groupId: string, userId: string): boolean {
    return this.moderatorIds.get(groupId)?.delete(userId) ?? false;
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
