import type { Queryable } from "./queryable.js";
import { SCHEMA_SQL } from "./schema.js";

/**
 * 老库补列（`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效）。
 *
 * SQLite 与 PostgreSQL 都不支持 `ADD COLUMN IF NOT EXISTS`（PG 支持、SQLite 不支持），
 * 所以只能「先试再忽略『列已存在』」；**只忽略这一类错误**，其它错误照常抛出，
 * 不把真正的迁移失败吞掉。
 */
const COLUMN_MIGRATIONS: readonly string[] = [
  "ALTER TABLE punishment_records ADD COLUMN message_excerpt TEXT NOT NULL DEFAULT ''",
];

export async function migrate(db: Queryable): Promise<void> {
  await db.query(SCHEMA_SQL);
  for (const sql of COLUMN_MIGRATIONS) {
    try {
      await db.query(sql);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }
  }
}

/** SQLite：`duplicate column name: x`；PostgreSQL：`column "x" of relation "y" already exists`。 */
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name|already exists|duplicate column/iu.test(message);
}
