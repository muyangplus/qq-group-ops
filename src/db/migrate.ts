import type { Queryable } from "./queryable.js";
import { SCHEMA_SQL } from "./schema.js";

/** 启动期迁移里**不致命**的问题：进程照旧起来，但相关数据 / 列可能没归一到最新格式。 */
export interface MigrationIssue {
  /** 出问题的步骤名（日志、`/status proc` 用它定位）。 */
  step: string;
  error: string;
}

export interface MigrationResult {
  issues: MigrationIssue[];
}

/**
 * 老库补列（`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效）。
 *
 * SQLite 与 PostgreSQL 都不支持 `ADD COLUMN IF NOT EXISTS`（PG 支持、SQLite 不支持），
 * 所以只能「先试再忽略『列已存在』」；**只忽略这一类错误**，其它失败记进 `issues`。
 * 缺列会让对应字段写不进去（功能降级），但不该拦住整个进程启动。
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "punishment_records.message_excerpt",
    sql: "ALTER TABLE punishment_records ADD COLUMN message_excerpt TEXT NOT NULL DEFAULT ''",
  },
];

/**
 * 建库 / 升级。
 *
 * 只把**建表脚本**当硬要求（表都没有，业务无从谈起），其余步骤逐条兜住：
 * 补列、数据归一化失败都只记进 `issues`，由调用方记录并展示 —— 一条修不了的老数据
 * 不应该让机器人起不来（真机教训：数据归一化撞主键 → `npm start` 直接退出）。
 */
export async function migrate(db: Queryable): Promise<MigrationResult> {
  await db.query(SCHEMA_SQL);
  const issues: MigrationIssue[] = [];
  for (const migration of COLUMN_MIGRATIONS) {
    try {
      await db.query(migration.sql);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        issues.push({
          step: `column:${migration.name}`,
          error: describeError(error),
        });
      }
    }
  }
  issues.push(...(await runDataMigrations(db)));
  return { issues };
}

const DATA_MIGRATION_STEPS: ReadonlyArray<{
  name: string;
  run: (db: Queryable) => Promise<void>;
}> = [
  { name: "subscription-scopes", run: normalizeSubscriptionScopes },
  { name: "activity-subscriptions", run: moveActivitySubscriptions },
];

/**
 * 跑一遍数据归一化，返回**不致命**的问题清单。
 *
 * 每一步单独兜住：失败的那一步跳过、后面继续，失败信息带步骤名返回。
 * 单独导出是为了能在测试里反复跑（建表脚本跑第二遍会命中 `IF NOT EXISTS`，
 * 而 pg-mem 对「被跳过的 CREATE」会直接报「AST 未读完」）。
 */
export async function runDataMigrations(db: Queryable): Promise<MigrationIssue[]> {
  const issues: MigrationIssue[] = [];
  for (const step of DATA_MIGRATION_STEPS) {
    try {
      await step.run(db);
    } catch (error) {
      issues.push({ step: step.name, error: describeError(error) });
    }
  }
  return issues;
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

/** 活动订阅原本单独存 `activity_subscriptions` → 搬进统一订阅表（`activity:<群>`）。 */
async function moveActivitySubscriptions(db: Queryable): Promise<void> {
  await db.query(
    `INSERT INTO notification_subscriptions (user_id, scope, created_at)
     SELECT user_id, 'activity:' || group_id, created_at
     FROM activity_subscriptions
     WHERE true
     ON CONFLICT (user_id, scope) DO NOTHING`,
  );
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
  return /duplicate column name|already exists|duplicate column/iu.test(
    describeError(error),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
