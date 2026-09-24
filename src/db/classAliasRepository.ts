import type { ClassAlias, ClassAliasKind } from "../services/classAliases.js";
import type { Queryable } from "./queryable.js";

/**
 * 班级/学院/专业别名表（`class_aliases`）。
 *
 * 单独一张 `CREATE TABLE IF NOT EXISTS`，老库升级不需要 ALTER。
 * 别名全局唯一：同一个别名只能指向一个规范名。
 */
export interface ClassAliasRepository {
  findAll(): Promise<ClassAlias[]>;
  save(entry: ClassAlias): Promise<void>;
  remove(alias: string): Promise<void>;
}

interface ClassAliasRow {
  alias: string;
  target: string;
  kind: string;
}

const SELECT_ALL_SQL = `
SELECT alias, target, kind
FROM class_aliases
ORDER BY alias ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO class_aliases (alias, target, kind, updated_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (alias) DO UPDATE SET
  target = EXCLUDED.target,
  kind = EXCLUDED.kind,
  updated_at = NOW()
`.trim();

const DELETE_SQL = "DELETE FROM class_aliases WHERE alias = $1";

export class SqlClassAliasRepository implements ClassAliasRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ClassAlias[]> {
    const result = await this.db.query<ClassAliasRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      alias: row.alias,
      target: row.target,
      kind: row.kind as ClassAliasKind,
    }));
  }

  public async save(entry: ClassAlias): Promise<void> {
    await this.db.query(UPSERT_SQL, [entry.alias, entry.target, entry.kind]);
  }

  public async remove(alias: string): Promise<void> {
    await this.db.query(DELETE_SQL, [alias]);
  }
}
