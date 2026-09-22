export interface UserIdentity {
  officialId: string;
  qq: string;
}

export interface GroupIdentity {
  officialId: string;
  groupNumber: string;
}

export class IdentityMapService {
  private readonly qqByUserId = new Map<string, string>();
  private readonly userIdByQq = new Map<string, string>();
  private readonly groupNumberByGroupId = new Map<string, string>();
  private readonly groupIdByGroupNumber = new Map<string, string>();

  public bindUser(officialId: string, qq: string): void {
    const previousQq = this.qqByUserId.get(officialId);
    if (previousQq) {
      this.userIdByQq.delete(previousQq);
    }
    this.qqByUserId.set(officialId, qq);
    this.userIdByQq.set(qq, officialId);
  }

  public bindGroup(officialId: string, groupNumber: string): void {
    const previousGroupNumber = this.groupNumberByGroupId.get(officialId);
    if (previousGroupNumber) {
      this.groupIdByGroupNumber.delete(previousGroupNumber);
    }
    this.groupNumberByGroupId.set(officialId, groupNumber);
    this.groupIdByGroupNumber.set(groupNumber, officialId);
  }

  public resolveUserId(input: string): string | undefined {
    if (this.qqByUserId.has(input)) {
      return input;
    }
    return this.userIdByQq.get(input);
  }

  public resolveGroupId(input: string): string | undefined {
    if (this.groupNumberByGroupId.has(input)) {
      return input;
    }
    return this.groupIdByGroupNumber.get(input);
  }

  public getQq(officialId: string): string | undefined {
    return this.qqByUserId.get(officialId);
  }

  public getGroupNumber(officialId: string): string | undefined {
    return this.groupNumberByGroupId.get(officialId);
  }

  public listUsers(): UserIdentity[] {
    return [...this.qqByUserId.entries()]
      .map(([officialId, qq]) => ({ officialId, qq }))
      .sort((left, right) => left.officialId.localeCompare(right.officialId));
  }

  public listGroups(): GroupIdentity[] {
    return [...this.groupNumberByGroupId.entries()]
      .map(([officialId, groupNumber]) => ({ officialId, groupNumber }))
      .sort((left, right) => left.officialId.localeCompare(right.officialId));
  }
}
