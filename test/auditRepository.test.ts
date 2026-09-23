import { describe, expect, it } from "vitest";

import { AuditStatus } from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import { PostgresAuditRepository } from "../src/db/auditRepository.js";
import type { Queryable, QueryResult } from "../src/db/queryable.js";
import { SCHEMA_SQL } from "../src/db/schema.js";

class FakeQueryable implements Queryable {
  public readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  private readonly resultRows: unknown[];

  public constructor(resultRows: unknown[] = []) {
    this.resultRows = resultRows;
  }

  public async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    return { rows: this.resultRows as Row[] };
  }
}

describe("PostgresAuditRepository", () => {
  it("defines the expected schema tables", () => {
    expect(SCHEMA_SQL).toContain("audit_records");
    expect(SCHEMA_SQL).toContain("join_requests");
    expect(SCHEMA_SQL).toContain("group_configs");
    expect(SCHEMA_SQL).toContain("group_keywords");
    expect(SCHEMA_SQL).toContain("permission_grants");
    expect(SCHEMA_SQL).toContain("group_message_modes");
    expect(SCHEMA_SQL).toContain("activities");
    expect(SCHEMA_SQL).toContain("activity_registrations");
  });

  it("inserts audit records", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresAuditRepository(db);
    const record = {
      recordId: "rec1",
      groupId: "g1",
      actorId: "admin",
      targetUserId: "u1",
      action: "approve_join_request",
      status: AuditStatus.Approved,
      reason: "ok",
      createdAt: utcNow(),
    };

    await repository.append(record);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.text).toContain("INSERT INTO audit_records");
    expect(db.calls[0]?.values).toEqual([
      "rec1",
      "g1",
      "admin",
      "u1",
      "approve_join_request",
      "approved",
      "ok",
      record.createdAt.toISOString(),
    ]);
  });

  it("maps rows back to audit records", async () => {
    const db = new FakeQueryable([
      {
        record_id: "rec1",
        group_id: "g1",
        actor_id: "admin",
        target_user_id: "u1",
        action: "approve_join_request",
        status: "approved",
        reason: "ok",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const repository = new PostgresAuditRepository(db);

    await expect(repository.findByGroup("g1")).resolves.toEqual([
      {
        recordId: "rec1",
        groupId: "g1",
        actorId: "admin",
        targetUserId: "u1",
        action: "approve_join_request",
        status: "approved",
        reason: "ok",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("loads every record for startup hydration", async () => {
    const db = new FakeQueryable([
      {
        record_id: "rec1",
        group_id: "g1",
        actor_id: "admin",
        target_user_id: null,
        action: "manual",
        status: "executed",
        reason: "",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const repository = new PostgresAuditRepository(db);

    const records = await repository.findAll();

    expect(db.calls[0]?.text).toContain("FROM audit_records");
    expect(records).toEqual([
      {
        recordId: "rec1",
        groupId: "g1",
        actorId: "admin",
        action: "manual",
        status: "executed",
        reason: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
  });
});
