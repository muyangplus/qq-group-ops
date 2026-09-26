import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/migrate.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

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
