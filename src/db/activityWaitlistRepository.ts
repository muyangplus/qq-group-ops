import type { Queryable } from "./queryable.js";

/**
 * 活动候补名单（`activity_waitlist`）。
 *
 * 名额满了之后的报名进入候补，按 `created_at` 排序；有人取消报名时自动递补第一位。
 * 独立新表（`CREATE TABLE IF NOT EXISTS`），老库升级不需要 ALTER。
 */
export interface ActivityWaitlistEntry {
  activityId: string;
  userId: string;
  displayName: string;
  note: string;
  createdAt: Date;
}

export interface ActivityWaitlistRepository {
  findAll(): Promise<ActivityWaitlistEntry[]>;
  save(entry: ActivityWaitlistEntry): Promise<void>;
  remove(activityId: string, userId: string): Promise<void>;
}

interface ActivityWaitlistRow {
  activity_id: string;
  user_id: string;
  display_name: string;
  note: string;
  created_at: string | Date;
}

const SELECT_ALL_SQL = `
SELECT activity_id, user_id, display_name, note, created_at
FROM activity_waitlist
ORDER BY activity_id ASC, created_at ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO activity_waitlist (
  activity_id, user_id, display_name, note, created_at
) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (activity_id, user_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  note = EXCLUDED.note
`.trim();

const DELETE_SQL =
  "DELETE FROM activity_waitlist WHERE activity_id = $1 AND user_id = $2";

export class SqlActivityWaitlistRepository implements ActivityWaitlistRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ActivityWaitlistEntry[]> {
    const result = await this.db.query<ActivityWaitlistRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      activityId: row.activity_id,
      userId: row.user_id,
      displayName: row.display_name,
      note: row.note,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    }));
  }

  public async save(entry: ActivityWaitlistEntry): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      entry.activityId,
      entry.userId,
      entry.displayName,
      entry.note,
      entry.createdAt.toISOString(),
    ]);
  }

  public async remove(activityId: string, userId: string): Promise<void> {
    await this.db.query(DELETE_SQL, [activityId, userId]);
  }
}
