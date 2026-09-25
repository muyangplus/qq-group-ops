import type { Queryable } from "./queryable.js";

/**
 * 活动绑定群（`activity_groups`，§B4）。
 *
 * 一个活动可以绑定**多个群**：发布时把成员卡发到所有绑定群，满员时也在所有绑定群
 * 广播一次「已满」卡。创建活动会自动绑定创建群；绑定关系独立成表
 * （`CREATE TABLE IF NOT EXISTS`），老库升级不需要 ALTER。
 *
 * 注意与 `activities.group_id` 的分工：后者是活动的**归属群**（创建地、权限判断依据），
 * 前者是**发布/广播的目标群集合**。老活动没有绑定行时，调用方回落到归属群。
 */
export interface ActivityGroup {
  activityId: string;
  groupId: string;
  createdAt: Date;
}

export interface ActivityGroupRepository {
  findAll(): Promise<ActivityGroup[]>;
  save(entry: ActivityGroup): Promise<void>;
  remove(activityId: string, groupId: string): Promise<void>;
}

interface ActivityGroupRow {
  activity_id: string;
  group_id: string;
  created_at: string | Date;
}

const SELECT_ALL_SQL = `
SELECT activity_id, group_id, created_at
FROM activity_groups
ORDER BY activity_id ASC, created_at ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO activity_groups (activity_id, group_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT (activity_id, group_id) DO NOTHING
`.trim();

const DELETE_SQL =
  "DELETE FROM activity_groups WHERE activity_id = $1 AND group_id = $2";

export class SqlActivityGroupRepository implements ActivityGroupRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ActivityGroup[]> {
    const result = await this.db.query<ActivityGroupRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      activityId: row.activity_id,
      groupId: row.group_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    }));
  }

  public async save(entry: ActivityGroup): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      entry.activityId,
      entry.groupId,
      entry.createdAt.toISOString(),
    ]);
  }

  public async remove(activityId: string, groupId: string): Promise<void> {
    await this.db.query(DELETE_SQL, [activityId, groupId]);
  }
}
