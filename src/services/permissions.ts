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
  private readonly superAdminIds: ReadonlySet<string>;
  private readonly groupAdminIds: ReadonlyMap<string, ReadonlySet<string>>;
  private readonly moderatorIds: ReadonlyMap<string, ReadonlySet<string>>;

  public constructor(policy: PermissionPolicy = {}) {
    this.superAdminIds = policy.superAdminIds ?? new Set();
    this.groupAdminIds = policy.groupAdminIds ?? new Map();
    this.moderatorIds = policy.moderatorIds ?? new Map();
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

  public ensure(allowed: boolean, message = "permission denied"): void {
    if (!allowed) {
      throw new PermissionDeniedError(message);
    }
  }
}
