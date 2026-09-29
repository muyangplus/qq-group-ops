import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { migrate, runDataMigrations } from "../src/db/migrate.js";
import type { Queryable } from "../src/db/queryable.js";
import { openSqliteDatabase } from "../src/db/sqliteDatabase.js";
import { SqliteQueryable } from "../src/db/sqliteQueryable.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";
import { TEST_DATABASES } from "./helpers/testDatabases.js";

describe("migrate", () => {
  it("runs the schema SQL", async () => {
    const db = new FakeQueryable();
    await migrate(db);
    // 第一次是建表脚本，之后是「老库补列」（ADD COLUMN 失败时被幂等忽略）
    expect(db.calls[0]?.text).toContain("CREATE TABLE IF NOT EXISTS audit_records");
    expect(db.calls[0]?.text).toContain("CREATE TABLE IF NOT EXISTS group_configs");
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS identity_bindings",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS class_aliases",
    );    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS activity_waitlist",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS activity_settings",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS activity_subscriptions",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS activity_notifications",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE INDEX IF NOT EXISTS activity_notifications_user_idx",
    );
    // §B4：活动绑定多个群（发布与满员广播的目标群）
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS activity_groups",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE INDEX IF NOT EXISTS activity_groups_group_idx",
    );
    // §A5 / §B7 / §B8：黑名单、处罚记录、申诉记录
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS blacklist_entries",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS punishment_records",
    );
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS appeal_records",
    );
    // §B7：处罚原文列（可选，受 RAW_MESSAGE_RETENTION_DAYS 控制）
    expect(db.calls[0]?.text).toContain("message_excerpt TEXT NOT NULL DEFAULT ''");
    // 老库（建表时还没有该列）靠后续的 ALTER 补齐；列已存在时该错误被忽略
    expect(db.calls[1]?.text).toBe(
      "ALTER TABLE punishment_records ADD COLUMN message_excerpt TEXT NOT NULL DEFAULT ''",
    );
  });

  it("ignores the duplicate-column error but rethrows anything else", async () => {
    const duplicate = new FakeQueryable();
    duplicate.failWith = (text) =>
      text.startsWith("ALTER TABLE")
        ? new Error("duplicate column name: message_excerpt")
        : undefined;
    await expect(migrate(duplicate)).resolves.toBeUndefined();

    // PostgreSQL 的措辞
    const pgStyle = new FakeQueryable();
    pgStyle.failWith = (text) =>
      text.startsWith("ALTER TABLE")
        ? new Error('column "message_excerpt" of relation "punishment_records" already exists')
        : undefined;
    await expect(migrate(pgStyle)).resolves.toBeUndefined();

    const other = new FakeQueryable();
    other.failWith = (text) =>
      text.startsWith("ALTER TABLE") ? new Error("disk I/O error") : undefined;
    await expect(migrate(other)).rejects.toThrow("disk I/O error");
  });
});

/**
 * 订阅表的启动期数据迁移（真实 SQL，两种方言各跑一遍）。
 *
 * 老 bug：迁移把「没有已知频道前缀」的 scope 一律当成老格式加上 `join:`，
 * 于是 0.19.0 起新话题（`bot_join:all` 等）被改成 `join:bot_join:all`；
 * 启动时会为超管补种新话题行，下一次启动再迁移时就会撞主键：
 * `UNIQUE constraint failed: notification_subscriptions.user_id, notification_subscriptions.scope`（真机启动失败）。
 */
for (const driver of TEST_DATABASES) {
  describe(`subscription scope migration [${driver.name}]`, () => {
    async function withDb(
      rows: ReadonlyArray<readonly [string, string]>,
      run: (queryable: Queryable) => Promise<void>,
      times = 1,
    ): Promise<void> {
      const database = await driver.create();
      try {
        for (const [userId, scope] of rows) {
          await database.queryable.query(
            `INSERT INTO notification_subscriptions (user_id, scope)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userId, scope],
          );
        }
        for (let index = 0; index < times; index += 1) {
          await runDataMigrations(database.queryable);
        }
        await run(database.queryable);
      } finally {
        await database.cleanup();
      }
    }

    async function scopesOf(queryable: Queryable, userId: string): Promise<string[]> {
      const result = await queryable.query<{ scope: string }>(
        "SELECT scope FROM notification_subscriptions WHERE user_id = $1 ORDER BY scope",
        [userId],
      );
      return result.rows.map((row) => row.scope);
    }

    it("prefixes only bare legacy scopes", async () => {
      await withDb(
        [
          ["u1", "g1"],
          ["u1", "all"],
          ["u1", "punish:g1"],
          ["u1", "bot_join:all"],
          ["u1", "unknown_event:all"],
        ],
        async (queryable) => {
          expect(await scopesOf(queryable, "u1")).toEqual([
            "bot_join:all",
            "join:all",
            "join:g1",
            "punish:g1",
            "unknown_event:all",
          ]);
        },
        // 迁移要反复跑都稳定（每次启动都会执行）
        2,
      );
    });

    it("repairs scopes that the old migration double-prefixed", async () => {
      await withDb(
        [
          ["u1", "join:bot_join:all"],
          ["u1", "bot_join:all"],
          ["u2", "join:member_join:all"],
        ],
        async (queryable) => {
          // 重复的（已经种回来的那行）保留一行真名，多出来的丢掉
          expect(await scopesOf(queryable, "u1")).toEqual(["bot_join:all"]);
          // 只有坏行时改回真名，不丢订阅
          expect(await scopesOf(queryable, "u2")).toEqual(["member_join:all"]);
        },
      );
    });

    it("does not fail when a legacy row and its prefixed form both exist", async () => {
      await withDb(
        [
          ["u1", "g1"],
          ["u1", "join:g1"],
        ],
        async (queryable) => {
          expect(await scopesOf(queryable, "u1")).toEqual(["join:g1"]);
        },
        2,
      );
    });

    it("reads a pre-0.19 group id as the join channel scope", async () => {
      await withDb([["u1", "group-openid-alpha"]], async (queryable) => {
        expect(await scopesOf(queryable, "u1")).toEqual([
          "join:group-openid-alpha",
        ]);
      });
    });
  });
}

/** 真机场景：库里已经有坏行时，**完整的 `migrate()`** 也必须能跑通（否则进程起不来）。 */
describe("migrate on a database that already has corrupted scopes [sqlite]", () => {
  it("repairs the rows and reports no error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-group-ops-migrate-"));
    const path = join(dir, "test.db");
    let db = await openSqliteDatabase(path);
    try {
      await migrate(new SqliteQueryable(db));
      await db
        .prepare(
          `INSERT INTO notification_subscriptions (user_id, scope) VALUES
             ('u1', 'join:bot_join:all'), ('u1', 'bot_join:all')`,
        )
        .run();
      db.close();

      // 重启：带上坏行的库必须能正常初始化
      db = await openSqliteDatabase(path);
      await expect(migrate(new SqliteQueryable(db))).resolves.toBeUndefined();
      const result = db
        .prepare(
          "SELECT scope FROM notification_subscriptions WHERE user_id = 'u1'",
        )
        .all();
      expect(result.map((row) => row.scope)).toEqual(["bot_join:all"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

