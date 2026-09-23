import type { Queryable } from "./queryable.js";

/**
 * 群配置的扩展键值对。
 *
 * 相比往 `group_configs` 加列，键值表的好处是：`CREATE TABLE IF NOT EXISTS`
 * 天然幂等（SQLite 无法 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`），
 * 以后新增配置项也不需要再次迁移。
 */
export interface GroupSetting {
  groupId: string;
  key: string;
  /** JSON 编码后的值，读取方负责解析。 */
  value: string;
}

export interface GroupSettingsRepository {
  findAll(): Promise<GroupSetting[]>;
  save(setting: GroupSetting): Promise<void>;
  remove(groupId: string, key: string): Promise<void>;
  /** 删除某个群（或 `__default__`）的全部扩展配置。 */
  removeAll(groupId: string): Promise<void>;
}

interface GroupSettingRow {
  group_id: string;
  setting_key: string;
  setting_value: string;
}

const UPSERT_SQL = `
INSERT INTO group_settings (group_id, setting_key, setting_value, updated_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (group_id, setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    updated_at = NOW()
`.trim();

const DELETE_SQL = `
DELETE FROM group_settings
WHERE group_id = $1 AND setting_key = $2
`.trim();

const DELETE_ALL_SQL = `
DELETE FROM group_settings
WHERE group_id = $1
`.trim();

const SELECT_ALL_SQL = `
SELECT group_id, setting_key, setting_value
FROM group_settings
ORDER BY group_id ASC, setting_key ASC
`.trim();

export class SqlGroupSettingsRepository implements GroupSettingsRepository {
  public constructor(private readonly db: Queryable) {}

  public async save(setting: GroupSetting): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      setting.groupId,
      setting.key,
      setting.value,
    ]);
  }

  public async remove(groupId: string, key: string): Promise<void> {
    await this.db.query(DELETE_SQL, [groupId, key]);
  }

  public async removeAll(groupId: string): Promise<void> {
    await this.db.query(DELETE_ALL_SQL, [groupId]);
  }

  public async findAll(): Promise<GroupSetting[]> {
    const result = await this.db.query<GroupSettingRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      groupId: row.group_id,
      key: row.setting_key,
      value: row.setting_value,
    }));
  }
}
