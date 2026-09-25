import type { Queryable } from "./queryable.js";

/**
 * 活动扩展设置（`activity_settings` 键值表）。
 *
 * 承载「@全体成员」「报名时私信通知发起人」「报名截止时间」等**后加的**活动配置项，
 * 避免给 `activity_details` / `activities` 做 ALTER（沿用 `group_settings` 的经验）。
 */
export interface ActivitySettingEntry {
  activityId: string;
  key: string;
  value: string;
}

export interface ActivitySettingsRepository {
  findAll(): Promise<ActivitySettingEntry[]>;
  save(entry: ActivitySettingEntry): Promise<void>;
  remove(activityId: string, key: string): Promise<void>;
}

interface ActivitySettingRow {
  activity_id: string;
  key: string;
  value: string;
}

const SELECT_ALL_SQL = `
SELECT activity_id, key, value
FROM activity_settings
ORDER BY activity_id ASC, key ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO activity_settings (activity_id, key, value, updated_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (activity_id, key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW()
`.trim();

const DELETE_SQL =
  "DELETE FROM activity_settings WHERE activity_id = $1 AND key = $2";

export class SqlActivitySettingsRepository implements ActivitySettingsRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ActivitySettingEntry[]> {
    const result = await this.db.query<ActivitySettingRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      activityId: row.activity_id,
      key: row.key,
      value: row.value,
    }));
  }

  public async save(entry: ActivitySettingEntry): Promise<void> {
    await this.db.query(UPSERT_SQL, [entry.activityId, entry.key, entry.value]);
  }

  public async remove(activityId: string, key: string): Promise<void> {
    await this.db.query(DELETE_SQL, [activityId, key]);
  }
}
