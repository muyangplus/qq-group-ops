import type { Queryable } from "./queryable.js";

/**
 * 活动通知去重与每人每日计数（`activity_notifications`）。
 *
 * 两个用途：
 * 1. **去重**：`(activity_id, user_id, kind)` 是主键，同一活动同一类型的通知只发一次
 *    （事件重投、`/activity` 重复操作、进程重启都不会重复打扰）；
 * 2. **每日封顶**：`countSince(userId, 今日 0 点)` 统计当天已发出的条数，超过上限就跳过，
 *    避免打满官方「单用户每天 1000 条、单关系 20 qpm」的主动消息额度。
 */
export type ActivityNotificationKind =
  | "published"
  | "changed"
  | "cancelled"
  | "promoted"
  /** 满员广播（群消息）：`user_id` 写 `group:<群ID>` 伪接收者，每个群只发一次。 */
  | "full";

export interface ActivityNotification {
  activityId: string;
  userId: string;
  kind: ActivityNotificationKind;
  createdAt: Date;
}

export interface ActivityNotificationRepository {
  findAll(): Promise<ActivityNotification[]>;
  save(entry: ActivityNotification): Promise<void>;
  /** 该用户在 `sinceIso`（含）之后收到的通知条数。 */
  countSince(userId: string, sinceIso: string): Promise<number>;
  /** 删除 `cutoff` 之前（不含）的记录。 */
  deleteOlderThan(cutoff: Date): Promise<void>;
}

interface ActivityNotificationRow {
  activity_id: string;
  user_id: string;
  kind: string;
  created_at: string | Date;
}

const SELECT_ALL_SQL = `
SELECT activity_id, user_id, kind, created_at
FROM activity_notifications
ORDER BY activity_id ASC, user_id ASC, kind ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO activity_notifications (activity_id, user_id, kind, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (activity_id, user_id, kind) DO NOTHING
`.trim();

const COUNT_SINCE_SQL = `
SELECT COUNT(*) AS count
FROM activity_notifications
WHERE user_id = $1 AND created_at >= $2
`.trim();

const DELETE_OLDER_SQL =
  "DELETE FROM activity_notifications WHERE created_at < $1";

export class SqlActivityNotificationRepository
  implements ActivityNotificationRepository
{
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ActivityNotification[]> {
    const result = await this.db.query<ActivityNotificationRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      activityId: row.activity_id,
      userId: row.user_id,
      kind: toKind(row.kind),
      createdAt: toDate(row.created_at),
    }));
  }

  public async save(entry: ActivityNotification): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      entry.activityId,
      entry.userId,
      entry.kind,
      entry.createdAt.toISOString(),
    ]);
  }

  public async countSince(userId: string, sinceIso: string): Promise<number> {
    const result = await this.db.query<{ count: number | string }>(
      COUNT_SINCE_SQL,
      [userId, sinceIso],
    );
    const raw = result.rows[0]?.count ?? 0;
    const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  public async deleteOlderThan(cutoff: Date): Promise<void> {
    await this.db.query(DELETE_OLDER_SQL, [cutoff.toISOString()]);
  }
}

/** 历史数据里可能写入未知 kind：按去重键原样保留，这里收敛成联合类型的合法值。 */
function toKind(value: string): ActivityNotificationKind {
  return value === "published" ||
    value === "changed" ||
    value === "cancelled" ||
    value === "promoted" ||
    value === "full"
    ? value
    : "changed";
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
