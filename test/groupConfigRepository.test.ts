import { describe, expect, it } from "vitest";

import { PostgresGroupConfigRepository } from "../src/db/groupConfigRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("PostgresGroupConfigRepository", () => {
  it("saves partial overrides with nulls", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresGroupConfigRepository(db);

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
    const repository = new PostgresGroupConfigRepository(db);

    await expect(repository.loadOverride("g1")).resolves.toEqual({
      groupId: "g1",
      joinAuditEnabled: true,
      autoApproveJoin: false,
      rawMessageRetentionDays: 7,
    });
  });

  it("replaces keywords", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresGroupConfigRepository(db);

    await repository.replaceKeywords("g1", ["广告", "刷屏"]);

    expect(db.calls[0]?.text).toContain("DELETE FROM group_keywords");
    expect(db.calls[1]?.values).toEqual(["g1", "广告"]);
    expect(db.calls[2]?.values).toEqual(["g1", "刷屏"]);
  });

  it("loads keywords", async () => {
    const db = new FakeQueryable([[{ keyword: "广告" }, { keyword: "刷屏" }]]);
    const repository = new PostgresGroupConfigRepository(db);
    await expect(repository.loadKeywords("g1")).resolves.toEqual(["广告", "刷屏"]);
  });

  it("deletes overrides", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresGroupConfigRepository(db);
    await repository.deleteOverride("g1");
    expect(db.calls[0]?.text).toContain("DELETE FROM group_configs");
    expect(db.calls[0]?.values).toEqual(["g1"]);
  });
});
