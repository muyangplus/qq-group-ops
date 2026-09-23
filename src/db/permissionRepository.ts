import type { Queryable } from "./queryable.js";

export type PermissionGrantScope = "super_admin" | "group_admin" | "moderator";

export interface PermissionGrant {
  /**
   * `super_admin` 表示超级管理员：
   * - `groupId === ""` → 全局超级管理员（拥有平台级能力）；
   * - `groupId !== ""` → 本群超级管理员（仅在该群内拥有最高权限）。
   *
   * 复用同一个 scope 可以避免修改 `permission_grants` 的 CHECK 约束
   * （SQLite 无法直接修改列约束，需要重建表）。
   */
  scope: PermissionGrantScope;
  groupId: string;
  userId: string;
}

export interface PermissionRepository {
  save(grant: PermissionGrant): Promise<void>;
  remove(grant: PermissionGrant): Promise<void>;
  findAll(): Promise<PermissionGrant[]>;
}

interface PermissionGrantRow {
  scope: string;
  group_id: string;
  user_id: string;
}

const INSERT_SQL = `
INSERT INTO permission_grants (scope, group_id, user_id)
VALUES ($1, $2, $3)
ON CONFLICT (scope, group_id, user_id) DO NOTHING
`.trim();

const DELETE_SQL = `
DELETE FROM permission_grants
WHERE scope = $1 AND group_id = $2 AND user_id = $3
`.trim();

const SELECT_ALL_SQL = `
SELECT scope, group_id, user_id
FROM permission_grants
ORDER BY scope ASC, group_id ASC, user_id ASC
`.trim();

export class SqlPermissionRepository implements PermissionRepository {
  public constructor(private readonly db: Queryable) {}

  public async save(grant: PermissionGrant): Promise<void> {
    await this.db.query(INSERT_SQL, [grant.scope, grant.groupId, grant.userId]);
  }

  public async remove(grant: PermissionGrant): Promise<void> {
    await this.db.query(DELETE_SQL, [grant.scope, grant.groupId, grant.userId]);
  }

  public async findAll(): Promise<PermissionGrant[]> {
    const result = await this.db.query<PermissionGrantRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      scope: parseScope(row.scope),
      groupId: row.group_id,
      userId: row.user_id,
    }));
  }
}

function parseScope(value: string): PermissionGrantScope {
  if (
    value === "super_admin" ||
    value === "group_admin" ||
    value === "moderator"
  ) {
    return value;
  }
  throw new Error(`unknown permission scope: ${value}`);
}
