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
  await runDataMigrations(db);
}

/**
 * 启动期的数据归一化（每次启动都会执行，**必须幂等**）。
 *
 * 单独导出是为了能在测试里反复跑：建表脚本跑第二遍会命中 `IF NOT EXISTS`，
 * 而 pg-mem 对「被跳过的 CREATE」会直接报「AST 未读完」。
 */
export async function runDataMigrations(db: Queryable): Promise<void> {
  await normalizeSubscriptionScopes(db);
  // 活动订阅原来单独存 `activity_subscriptions` → 搬进统一订阅表（`activity:<群>`）。
  await db.query(
    `INSERT INTO notification_subscriptions (user_id, scope, created_at)
     SELECT user_id, 'activity:' || group_id, created_at
     FROM activity_subscriptions
     WHERE true
     ON CONFLICT (user_id, scope) DO NOTHING`,
  );
}

interface SubscriptionRow {
  user_id: string;
  scope: string;
}

const SELECT_SUBSCRIPTIONS_SQL = "SELECT user_id, scope FROM notification_subscriptions";
const DELETE_SUBSCRIPTION_SQL =
  "DELETE FROM notification_subscriptions WHERE user_id = $1 AND scope = $2";
const INSERT_SUBSCRIPTION_SQL = `
INSERT INTO notification_subscriptions (user_id, scope, created_at)
VALUES ($1, $2, NOW())
ON CONFLICT (user_id, scope) DO NOTHING
`.trim();

/**
 * 通知订阅的 scope 归一到统一的 `话题:范围` 键。
 *
 * 1. **修复 0.19.0–0.21.0 的迁移 bug**：当时的判据是「没有 `join:` / `punish:` / `activity:` 前缀
 *    就当成老格式补 `join:`」，于是 0.19.0 起的新话题被二次加前缀（`bot_join:all` →
 *    `join:bot_join:all`）；而新话题的订阅行会在启动时补种，下一次启动再迁移就会撞主键
 *    （`UNIQUE constraint failed: notification_subscriptions.user_id, notification_subscriptions.scope`），
 *    机器人直接起不来。真名里本来就带冒号，所以「`join:` 之后还有冒号」只可能是坏行：
 *    已经有正确行时删掉它，否则改回真名（订阅不丢）；
 * 2. **老格式**（0.19.0 之前的 `join` 频道）的 scope 是裸的群 id / `all`，**不带冒号** ——
 *    只补这一类，不会碰到任何 `话题:范围` 行。
 *
 * 为什么放在迁移里而不是服务 `load()`：数据库先于所有服务就绪，
 * 服务起来时读到的就已经是归一化后的数据，不用在业务代码里兼容老格式。
 */
async function normalizeSubscriptionScopes(db: Queryable): Promise<void> {
  const result = await db.query<SubscriptionRow>(SELECT_SUBSCRIPTIONS_SQL);
  const present = new Set(
    result.rows.map((row) => subscriptionKey(row.user_id, row.scope)),
  );
  for (const row of result.rows) {
    const target = normalizeSubscriptionScope(row.scope);
    if (target === undefined) {
      continue;
    }
    const targetKey = subscriptionKey(row.user_id, target);
    // 先删后插：目标是主键的一部分，直接改名会撞上「已存在的正确行」
    await db.query(DELETE_SUBSCRIPTION_SQL, [row.user_id, row.scope]);
    present.delete(subscriptionKey(row.user_id, row.scope));
    if (!present.has(targetKey)) {
      await db.query(INSERT_SUBSCRIPTION_SQL, [row.user_id, target]);
      present.add(targetKey);
    }
  }
}

/** 归一化后的 scope；已经是目标格式时返回 `undefined`。 */
function normalizeSubscriptionScope(scope: string): string | undefined {
  if (scope.startsWith("join:") && scope.slice("join:".length).includes(":")) {
    // 被二次加前缀的新话题：`join:bot_join:all` → `bot_join:all`
    return scope.slice("join:".length);
  }
  if (!scope.includes(":")) {
    // 0.19.0 之前的 join 频道裸 scope：`g1` → `join:g1`
    return `join:${scope}`;
  }
  return undefined;
}

function subscriptionKey(userId: string, scope: string): string {
  return `${userId}\u0000${scope}`;
}

/** SQLite：`duplicate column name: x`；PostgreSQL：`column "x" of relation "y" already exists`。 */
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name|already exists|duplicate column/iu.test(message);
}
