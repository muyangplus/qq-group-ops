import type { Queryable } from "./queryable.js";

/**
 * 平台级热配置（全局超管可在运行时改）。
 *
 * 一张独立键值表：`CREATE TABLE IF NOT EXISTS` 天然幂等，老库升级不需要 ALTER，
 * 以后新增可热改的项也不用再动 schema（与 `group_settings` 同一套经验）。
 */
export interface PlatformSetting {
  key: string;
  /** JSON 编码后的值，读取方负责解析。 */
  value: string;
}

export interface PlatformSettingsRepository {
  findAll(): Promise<PlatformSetting[]>;
  save(setting: PlatformSetting): Promise<void>;
  remove(key: string): Promise<void>;
}

interface PlatformSettingRow {
  setting_key: string;
  setting_value: string;
}

const UPSERT_SQL = `
INSERT INTO platform_settings (setting_key, setting_value, updated_at)
VALUES ($1, $2, NOW())
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    updated_at = NOW()
`.trim();

const DELETE_SQL = "DELETE FROM platform_settings WHERE setting_key = $1";

const SELECT_ALL_SQL = `
SELECT setting_key, setting_value
FROM platform_settings
ORDER BY setting_key ASC
`.trim();

export class SqlPlatformSettingsRepository implements PlatformSettingsRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<PlatformSetting[]> {
    const result = await this.db.query<PlatformSettingRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      key: row.setting_key,
      value: row.setting_value,
    }));
  }

  public async save(setting: PlatformSetting): Promise<void> {
    await this.db.query(UPSERT_SQL, [setting.key, setting.value]);
  }

  public async remove(key: string): Promise<void> {
    await this.db.query(DELETE_SQL, [key]);
  }
}
