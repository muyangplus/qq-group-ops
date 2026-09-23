import { getLogger } from "../core/logger.js";
import type {
  IdentityBinding,
  IdentityBindingKind,
  IdentityBindingRepository,
} from "../db/identityBindingRepository.js";

const log = getLogger("identity-map");

export interface UserIdentity {
  officialId: string;
  qq: string;
}

export interface GroupIdentity {
  officialId: string;
  groupNumber: string;
}

interface UserMaps {
  qqByUserId: Map<string, string>;
  userIdByQq: Map<string, string>;
}

interface GroupMaps {
  groupNumberByGroupId: Map<string, string>;
  groupIdByGroupNumber: Map<string, string>;
}

/**
 * OpenID ↔ QQ号 / 群号 映射。
 *
 * 有仓储时采用「内存缓存 + 写穿透」：
 * - 启动时通过 `reload()` 从数据库载入全部绑定；
 * - `bindUser` / `bindGroup` 先更新内存，再写数据库，写失败会回滚内存并抛出；
 * - 读取仍然同步走内存，保证事件处理路径不被数据库延迟阻塞。
 */
export class IdentityMapService {
  private qqByUserId = new Map<string, string>();
  private userIdByQq = new Map<string, string>();
  private groupNumberByGroupId = new Map<string, string>();
  private groupIdByGroupNumber = new Map<string, string>();

  public constructor(private readonly repository?: IdentityBindingRepository) {}

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  /** 从数据库重新载入全部绑定，覆盖当前内存缓存。 */
  public async reload(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const bindings = await this.repository.findAll();
    this.replaceBindings(bindings);
    log.info("identity bindings loaded", {
      users: this.qqByUserId.size,
      groups: this.groupNumberByGroupId.size,
    });
  }

  public async bindUser(officialId: string, qq: string): Promise<void> {
    const snapshot = this.snapshotUsers();
    this.applyUserBinding(officialId, qq);
    try {
      await this.persistBinding("user", officialId, qq);
    } catch (error) {
      this.restoreUsers(snapshot);
      throw error;
    }
  }

  public async bindGroup(
    officialId: string,
    groupNumber: string,
  ): Promise<void> {
    const snapshot = this.snapshotGroups();
    this.applyGroupBinding(officialId, groupNumber);
    try {
      await this.persistBinding("group", officialId, groupNumber);
    } catch (error) {
      this.restoreGroups(snapshot);
      throw error;
    }
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

  private replaceBindings(bindings: readonly IdentityBinding[]): void {
    this.qqByUserId = new Map();
    this.userIdByQq = new Map();
    this.groupNumberByGroupId = new Map();
    this.groupIdByGroupNumber = new Map();
    for (const binding of bindings) {
      if (binding.kind === "user") {
        this.applyUserBinding(binding.officialId, binding.externalId);
      } else {
        this.applyGroupBinding(binding.officialId, binding.externalId);
      }
    }
  }

  private applyUserBinding(officialId: string, qq: string): void {
    const previousQq = this.qqByUserId.get(officialId);
    if (previousQq && previousQq !== qq) {
      this.userIdByQq.delete(previousQq);
    }
    const previousOwner = this.userIdByQq.get(qq);
    if (previousOwner && previousOwner !== officialId) {
      this.qqByUserId.delete(previousOwner);
    }
    this.qqByUserId.set(officialId, qq);
    this.userIdByQq.set(qq, officialId);
  }

  private applyGroupBinding(officialId: string, groupNumber: string): void {
    const previousGroupNumber = this.groupNumberByGroupId.get(officialId);
    if (previousGroupNumber && previousGroupNumber !== groupNumber) {
      this.groupIdByGroupNumber.delete(previousGroupNumber);
    }
    const previousOwner = this.groupIdByGroupNumber.get(groupNumber);
    if (previousOwner && previousOwner !== officialId) {
      this.groupNumberByGroupId.delete(previousOwner);
    }
    this.groupNumberByGroupId.set(officialId, groupNumber);
    this.groupIdByGroupNumber.set(groupNumber, officialId);
  }

  private async persistBinding(
    kind: IdentityBindingKind,
    officialId: string,
    externalId: string,
  ): Promise<void> {
    if (!this.repository) {
      return;
    }
    await this.repository.bind(kind, officialId, externalId);
  }

  private snapshotUsers(): UserMaps {
    return {
      qqByUserId: new Map(this.qqByUserId),
      userIdByQq: new Map(this.userIdByQq),
    };
  }

  private snapshotGroups(): GroupMaps {
    return {
      groupNumberByGroupId: new Map(this.groupNumberByGroupId),
      groupIdByGroupNumber: new Map(this.groupIdByGroupNumber),
    };
  }

  private restoreUsers(snapshot: UserMaps): void {
    this.qqByUserId = snapshot.qqByUserId;
    this.userIdByQq = snapshot.userIdByQq;
  }

  private restoreGroups(snapshot: GroupMaps): void {
    this.groupNumberByGroupId = snapshot.groupNumberByGroupId;
    this.groupIdByGroupNumber = snapshot.groupIdByGroupNumber;
  }
}
