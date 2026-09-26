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
  for (const sql of DATA_MIGRATIONS) {
    await db.query(sql);
  }
}

/**
 * 一次性数据迁移（幂等：重复执行等价于什么都不做）。
 *
 * 通知订阅从「按频道加前缀」升级为**统一 `频道:范围` 键**：
 * 1. 老库里 `join` 频道的 scope 没有前缀 → 补上 `join:`；
 * 2. 活动订阅原来单独存 `activity_subscriptions` → 搬进统一订阅表（`activity:<群>`）。
 *
 * 为什么放在迁移里而不是服务 `load()`：数据库先于所有服务就绪，
 * 服务起来时读到的就已经是归一化后的数据，不用在业务代码里兼容老格式。
 */
const DATA_MIGRATIONS: readonly string[] = [
  `UPDATE notification_subscriptions
   SET scope = 'join:' || scope
   WHERE scope NOT LIKE 'join:%'
     AND scope NOT LIKE 'punish:%'
     AND scope NOT LIKE 'activity:%'`,
  `INSERT INTO notification_subscriptions (user_id, scope, created_at)
   SELECT user_id, 'activity:' || group_id, created_at
   FROM activity_subscriptions
   WHERE true
   ON CONFLICT (user_id, scope) DO NOTHING`,
];

/** SQLite：`duplicate column name: x`；PostgreSQL：`column "x" of relation "y" already exists`。 */
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name|already exists|duplicate column/iu.test(message);
}
