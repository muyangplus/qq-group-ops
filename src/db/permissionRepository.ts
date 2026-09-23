import type { Queryable } from "./queryable.js";

export type PermissionGrantScope = "super_admin" | "group_admin" | "moderator";

export interface PermissionGrant {
  scope: PermissionGrantScope;
  /** 超级管理员使用空字符串。 */
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
