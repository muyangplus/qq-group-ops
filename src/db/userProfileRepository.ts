import type { Queryable } from "./queryable.js";
import type { UserProfile } from "../services/userProfiles.js";

/**
 * 个人资料：班级 / 学院 / 姓名 / 学号。
 *
 * 单独一张表（`CREATE TABLE IF NOT EXISTS`），因此老库升级不需要 ALTER。
 */
export interface UserProfileRepository {
  findAll(): Promise<UserProfile[]>;
  save(profile: UserProfile): Promise<void>;
  remove(userId: string): Promise<void>;
}

interface UserProfileRow {
  user_id: string;
  name: string;
  student_id: string;
  class_name: string;
  college: string;
  year: string;
}

const SELECT_ALL_SQL = `
SELECT user_id, name, student_id, class_name, college, year
FROM user_profiles
ORDER BY user_id ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO user_profiles (
  user_id, name, student_id, class_name, college, year, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, NOW())
ON CONFLICT (user_id) DO UPDATE SET
  name = EXCLUDED.name,
  student_id = EXCLUDED.student_id,
  class_name = EXCLUDED.class_name,
  college = EXCLUDED.college,
  year = EXCLUDED.year,
  updated_at = NOW()
`.trim();

const DELETE_SQL = "DELETE FROM user_profiles WHERE user_id = $1";

export class SqlUserProfileRepository implements UserProfileRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<UserProfile[]> {
    const result = await this.db.query<UserProfileRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      studentId: row.student_id,
      className: row.class_name,
      college: row.college,
      year: row.year,
    }));
  }

  public async save(profile: UserProfile): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      profile.userId,
      profile.name,
      profile.studentId,
      profile.className,
      profile.college,
      profile.year,
    ]);
  }

  public async remove(userId: string): Promise<void> {
    await this.db.query(DELETE_SQL, [userId]);
  }
}
