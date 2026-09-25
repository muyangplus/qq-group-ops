import type { Queryable } from "./queryable.js";

/**
 * 黑名单（`blacklist_entries`，§A5）。
 *
 * - `scope = group`：只影响 `groupId` 这一个群；
 * - `scope = global`：影响机器人**所有已绑定群**，此时 `groupId` 存空串；
 * - 主键 `(scope, groupId, userId)`，重复加入按最新一次覆盖（原因 / 操作者 / 时间）。
 */
export type BlacklistScope = "group" | "global";

export interface BlacklistEntry {
  scope: BlacklistScope;
  /** `scope=group` 时的群；`scope=global` 时为空串。 */
  groupId: string;
  userId: string;
  reason: string;
  /** 操作者：审核员 / 管理员的 userId，或 `bot:auto`。 */
  actorId: string;
  /** 来源：`manual` / `keyword`（关键词命中自动拉黑）/ `card`（卡片动作）。 */
  source: string;
  createdAt: Date;
}

export interface BlacklistRepository {
  findAll(): Promise<BlacklistEntry[]>;
  save(entry: BlacklistEntry): Promise<void>;
  remove(input: {
    scope: BlacklistScope;
    groupId: string;
    userId: string;
  }): Promise<void>;
}

interface BlacklistRow {
  scope: string;
  group_id: string;
  user_id: string;
  reason: string;
  actor_id: string;
  source: string;
  created_at: string | Date;
}

const SELECT_ALL_SQL = `
SELECT scope, group_id, user_id, reason, actor_id, source, created_at
FROM blacklist_entries
ORDER BY created_at DESC
`.trim();

const UPSERT_SQL = `
INSERT INTO blacklist_entries (
  scope, group_id, user_id, reason, actor_id, source, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (scope, group_id, user_id) DO UPDATE SET
  reason = $4,
  actor_id = $5,
  source = $6,
  created_at = $7
`.trim();

const DELETE_SQL = `
DELETE FROM blacklist_entries
WHERE scope = $1 AND group_id = $2 AND user_id = $3
`.trim();

export class SqlBlacklistRepository implements BlacklistRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<BlacklistEntry[]> {
    const result = await this.db.query<BlacklistRow>(SELECT_ALL_SQL);
    return result.rows.map(rowToEntry);
  }

  public async save(entry: BlacklistEntry): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      entry.scope,
      entry.groupId,
      entry.userId,
      entry.reason,
      entry.actorId,
      entry.source,
      entry.createdAt.toISOString(),
    ]);
  }

  public async remove(input: {
    scope: BlacklistScope;
    groupId: string;
    userId: string;
  }): Promise<void> {
    await this.db.query(DELETE_SQL, [
      input.scope,
      input.groupId,
      input.userId,
    ]);
  }
}

function rowToEntry(row: BlacklistRow): BlacklistEntry {
  return {
    scope: row.scope as BlacklistScope,
    groupId: row.group_id,
    userId: row.user_id,
    reason: row.reason,
    actorId: row.actor_id,
    source: row.source,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
  };
}
