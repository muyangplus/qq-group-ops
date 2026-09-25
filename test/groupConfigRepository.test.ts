import { describe, expect, it } from "vitest";

import { SqlGroupConfigRepository } from "../src/db/groupConfigRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("SqlGroupConfigRepository", () => {
  it("saves partial overrides with nulls", async () => {
    const db = new FakeQueryable();
    const repository = new SqlGroupConfigRepository(db);

    await repository.saveOverride({ groupId: "g1", autoApproveJoin: true });

    expect(db.calls[0]?.text).toContain("INSERT INTO group_configs");
    expect(db.calls[0]?.values).toEqual([
      "g1",
      null,
      null,
      true,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("loads overrides", async () => {
    const db = new FakeQueryable([
      [
        {
          group_id: "g1",
          enabled: null,
          join_audit_enabled: true,
          auto_approve_join: false,
          word_filter_enabled: null,
          export_enabled: null,
          raw_message_retention_days: 7,
          mute_duration_seconds: null,
          warning_message: null,
        },
      ],
    ]);
    const repository = new SqlGroupConfigRepository(db);

    await expect(repository.loadOverride("g1")).resolves.toEqual({
      groupId: "g1",
      joinAuditEnabled: true,
      autoApproveJoin: false,
      rawMessageRetentionDays: 7,
    });
  });

  it("replaces keywords", async () => {
    const db = new FakeQueryable();
    const repository = new SqlGroupConfigRepository(db);

    await repository.replaceKeywords("g1", ["广告", "刷屏"]);

    expect(db.calls[0]?.text).toContain("DELETE FROM group_keywords");
    expect(db.calls[1]?.values).toEqual(["g1", "广告"]);
    expect(db.calls[2]?.values).toEqual(["g1", "刷屏"]);
  });

  it("loads keywords", async () => {
    const db = new FakeQueryable([[{ keyword: "广告" }, { keyword: "刷屏" }]]);
    const repository = new SqlGroupConfigRepository(db);
    await expect(repository.loadKeywords("g1")).resolves.toEqual(["广告", "刷屏"]);
  });

  it("deletes overrides", async () => {
    const db = new FakeQueryable();
    const repository = new SqlGroupConfigRepository(db);
    await repository.deleteOverride("g1");
    expect(db.calls[0]?.text).toContain("DELETE FROM group_configs");
    expect(db.calls[0]?.values).toEqual(["g1"]);
  });

  it("clears only the requested columns", async () => {
    const db = new FakeQueryable();
    const repository = new SqlGroupConfigRepository(db);

    await repository.clearColumns("g1", ["autoApproveJoin", "warningMessage"]);

    expect(db.calls).toHaveLength(1);
    const sql = db.calls[0]?.text ?? "";
    expect(sql).toContain("UPDATE group_configs SET");
    expect(sql).toContain("auto_approve_join = NULL");
    expect(sql).toContain("warning_message = NULL");
    // 只清指定列：其它列不能出现在 SET 里
    expect(sql).not.toContain("enabled = NULL");
    expect(sql).not.toContain("join_audit_enabled = NULL");
    expect(db.calls[0]?.values).toEqual(["g1"]);
  });

  it("ignores keys that are not real columns (e.g. keywords)", async () => {
    const db = new FakeQueryable();
    const repository = new SqlGroupConfigRepository(db);

    await repository.clearColumns("g1", ["keywords"]);
    expect(db.calls).toHaveLength(0);

    await repository.clearColumns("g1", []);
    expect(db.calls).toHaveLength(0);
  });

  it("loads every override together with its keywords", async () => {
    const db = new FakeQueryable([
      [
        {
          group_id: "g1",
          enabled: true,
          join_audit_enabled: null,
          auto_approve_join: null,
          word_filter_enabled: null,
          export_enabled: null,
          raw_message_retention_days: null,
          mute_duration_seconds: null,
          warning_message: null,
        },
        {
          group_id: "g2",
          enabled: null,
          join_audit_enabled: null,
          auto_approve_join: true,
          word_filter_enabled: null,
          export_enabled: null,
          raw_message_retention_days: null,
          mute_duration_seconds: null,
          warning_message: null,
        },
      ],
      [
        { group_id: "g1", keyword: "广告" },
        { group_id: "g1", keyword: "刷屏" },
      ],
    ]);
    const repository = new SqlGroupConfigRepository(db);

    await expect(repository.findAll()).resolves.toEqual([
      { groupId: "g1", enabled: true, keywords: ["广告", "刷屏"] },
      { groupId: "g2", autoApproveJoin: true },
    ]);
  });
});
