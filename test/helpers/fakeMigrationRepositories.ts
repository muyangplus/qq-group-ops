import type { ActivityDetails } from "../../src/services/activity.js";
import type { ActivityDetailsRepository } from "../../src/db/activityDetailsRepository.js";
import type {
  ShortCodeEntry,
  ShortCodeRepository,
} from "../../src/db/shortCodeRepository.js";
import type { UserProfileRepository } from "../../src/db/userProfileRepository.js";
import type { UserProfile } from "../../src/services/userProfiles.js";

/**
 * 一次性迁移（`/migrate`）用到的内存替身。
 *
 * 行为与 SQL 仓储一致：`findAll` 返回副本、`save` 按主键覆盖；
 * 短码的 `replaceCode` 按旧码定位同一行（主键换码）。
 */
export class FakeMigrationShortCodeRepository implements ShortCodeRepository {
  public readonly rows: ShortCodeEntry[] = [];

  public async findAll(): Promise<ShortCodeEntry[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  public async save(entry: ShortCodeEntry): Promise<void> {
    if (
      this.rows.some(
        (row) =>
          row.code === entry.code ||
          (row.kind === entry.kind && row.targetId === entry.targetId),
      )
    ) {
      return;
    }
    this.rows.push({ ...entry });
  }

  public async replaceCode(
    oldCode: string,
    entry: ShortCodeEntry,
  ): Promise<void> {
    const index = this.rows.findIndex((row) => row.code === oldCode);
    if (index >= 0) {
      this.rows[index] = { ...entry };
    }
  }
}

export class FakeMigrationProfileRepository implements UserProfileRepository {
  public readonly rows = new Map<string, UserProfile>();

  public async findAll(): Promise<UserProfile[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  public async save(profile: UserProfile): Promise<void> {
    this.rows.set(profile.userId, { ...profile });
  }

  public async remove(userId: string): Promise<void> {
    this.rows.delete(userId);
  }
}

export class FakeMigrationActivityDetailsRepository
  implements ActivityDetailsRepository
{
  public readonly rows: ActivityDetails[] = [];

  public async findAll(): Promise<ActivityDetails[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  public async save(details: ActivityDetails): Promise<void> {
    const index = this.rows.findIndex(
      (row) => row.activityId === details.activityId,
    );
    if (index >= 0) {
      this.rows[index] = { ...details };
    } else {
      this.rows.push({ ...details });
    }
  }
}
