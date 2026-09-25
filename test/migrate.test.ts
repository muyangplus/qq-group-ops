import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/migrate.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("migrate", () => {
  it("runs the schema SQL", async () => {
    const db = new FakeQueryable();
    await migrate(db);
    expect(db.calls).toHaveLength(1);
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
  });
});
