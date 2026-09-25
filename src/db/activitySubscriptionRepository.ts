import type { Queryable } from "./queryable.js";

/**
 * 按群订阅「新活动通知」（`activity_subscriptions`）。
 *
 * 发布新活动时只私信**订阅了该群**的成员，避免给全群发主动消息（主动私信有限额，
 * 且用户可以在客户端关闭「允许主动发送」）。表是独立新表（`CREATE TABLE IF NOT EXISTS`），
 * 老库升级不需要 ALTER。
 */
export interface ActivitySubscription {
  groupId: string;
  userId: string;
  createdAt: Date;
}

export interface ActivitySubscriptionRepository {
  findAll(): Promise<ActivitySubscription[]>;
  save(entry: ActivitySubscription): Promise<void>;
  remove(groupId: string, userId: string): Promise<void>;
}

interface ActivitySubscriptionRow {
  group_id: string;
  user_id: string;
  created_at: string | Date;
}

const SELECT_ALL_SQL = `
SELECT group_id, user_id, created_at
FROM activity_subscriptions
ORDER BY group_id ASC, created_at ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO activity_subscriptions (group_id, user_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT (group_id, user_id) DO NOTHING
`.trim();

const DELETE_SQL =
  "DELETE FROM activity_subscriptions WHERE group_id = $1 AND user_id = $2";

export class SqlActivitySubscriptionRepository
  implements ActivitySubscriptionRepository
{
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ActivitySubscription[]> {
    const result = await this.db.query<ActivitySubscriptionRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      groupId: row.group_id,
      userId: row.user_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    }));
  }

  public async save(entry: ActivitySubscription): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      entry.groupId,
      entry.userId,
      entry.createdAt.toISOString(),
    ]);
  }

  public async remove(groupId: string, userId: string): Promise<void> {
    await this.db.query(DELETE_SQL, [groupId, userId]);
  }
}
