import type { Queryable } from "./queryable.js";
import type { ActivityDetails } from "../services/activity.js";

/**
 * 活动的扩展配置（短码、群号、链接、报名限制）。
 *
 * 独立于 `activities` 表：`CREATE TABLE IF NOT EXISTS` 幂等，
 * 老库升级不需要 ALTER TABLE，和 `group_settings` 的思路一致。
 */
export interface ActivityDetailsRepository {
  findAll(): Promise<ActivityDetails[]>;
  save(details: ActivityDetails): Promise<void>;
}

interface ActivityDetailsRow {
  activity_id: string;
  code: string;
  group_number: string;
  links: string;
  allow_colleges: string;
  deny_colleges: string;
  allow_years: string;
  deny_years: string;
}

const SELECT_ALL_SQL = `
SELECT activity_id, code, group_number, links,
       allow_colleges, deny_colleges, allow_years, deny_years
FROM activity_details
ORDER BY activity_id ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO activity_details (
  activity_id, code, group_number, links,
  allow_colleges, deny_colleges, allow_years, deny_years, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
ON CONFLICT (activity_id) DO UPDATE SET
  code = EXCLUDED.code,
  group_number = EXCLUDED.group_number,
  links = EXCLUDED.links,
  allow_colleges = EXCLUDED.allow_colleges,
  deny_colleges = EXCLUDED.deny_colleges,
  allow_years = EXCLUDED.allow_years,
  deny_years = EXCLUDED.deny_years,
  updated_at = NOW()
`.trim();

export class SqlActivityDetailsRepository implements ActivityDetailsRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ActivityDetails[]> {
    const result = await this.db.query<ActivityDetailsRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      activityId: row.activity_id,
      code: row.code,
      groupNumber: row.group_number,
      links: parseJson(row.links, []),
      rules: {
        allowColleges: parseJson(row.allow_colleges, []),
        denyColleges: parseJson(row.deny_colleges, []),
        allowYears: parseJson(row.allow_years, []),
        denyYears: parseJson(row.deny_years, []),
      },
    }));
  }

  public async save(details: ActivityDetails): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      details.activityId,
      details.code,
      details.groupNumber,
      JSON.stringify(details.links),
      JSON.stringify(details.rules.allowColleges),
      JSON.stringify(details.rules.denyColleges),
      JSON.stringify(details.rules.allowYears),
      JSON.stringify(details.rules.denyYears),
    ]);
  }
}

function parseJson<T>(raw: string, fallback: T[]): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}
