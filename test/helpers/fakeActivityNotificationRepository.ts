import type {
  ActivityNotification,
  ActivityNotificationRepository,
} from "../../src/db/activityNotificationRepository.js";

/**
 * 只读内存替身：`activity_notifications` 去重表。
 *
 * §B4 满员广播要断言「每个群一条 full 行（`group:<群ID>` 伪接收者）」，用真实 SQL
 * 仓储会引入数据库依赖，这里只需要 `findAll/save/countSince/deleteOlderThan`。
 */
export class FakeActivityNotificationRepository implements ActivityNotificationRepository {
  private readonly rows = new Map<string, ActivityNotification>();

  public async findAll(): Promise<ActivityNotification[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  public async save(entry: ActivityNotification): Promise<void> {
    this.rows.set(`${entry.activityId}\u0000${entry.userId}\u0000${entry.kind}`, {
      ...entry,
    });
  }

  public async countSince(userId: string, sinceIso: string): Promise<number> {
    const since = new Date(sinceIso).getTime();
    return [...this.rows.values()].filter(
      (row) => row.userId === userId && row.createdAt.getTime() >= since,
    ).length;
  }

  public async deleteOlderThan(cutoff: Date): Promise<void> {
    for (const [key, row] of [...this.rows]) {
      if (row.createdAt < cutoff) {
        this.rows.delete(key);
      }
    }
  }
}
