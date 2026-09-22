import { describe, expect, it } from "vitest";

import { JoinRequestStatus } from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import { PostgresJoinRequestRepository } from "../src/db/joinRequestRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("PostgresJoinRequestRepository", () => {
  it("upserts join requests", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresJoinRequestRepository(db);
    const createdAt = utcNow();

    await repository.upsert({
      requestId: "r1",
      groupId: "g1",
      userId: "u1",
      reason: "想加入",
      status: JoinRequestStatus.Pending,
      createdAt,
    });

    expect(db.calls[0]?.text).toContain("INSERT INTO join_requests");
    expect(db.calls[0]?.text).toContain("ON CONFLICT (request_id) DO NOTHING");
    expect(db.calls[0]?.values).toEqual([
      "r1",
      "g1",
      "u1",
      "想加入",
      "pending",
      createdAt.toISOString(),
    ]);
  });

  it("maps pending rows", async () => {
    const db = new FakeQueryable([
      [
        {
          request_id: "r1",
          group_id: "g1",
          user_id: "u1",
          reason: "想加入",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
          reviewed_at: null,
          reviewer_id: null,
        },
      ],
    ]);
    const repository = new PostgresJoinRequestRepository(db);

    await expect(repository.findPending("g1")).resolves.toEqual([
      {
        requestId: "r1",
        groupId: "g1",
        userId: "u1",
        reason: "想加入",
        status: "pending",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("updates review status", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresJoinRequestRepository(db);
    const reviewedAt = utcNow();

    await repository.updateStatus(
      "r1",
      JoinRequestStatus.Rejected,
      "admin",
      reviewedAt,
      "资料不完整",
    );

    expect(db.calls[0]?.text).toContain("UPDATE join_requests");
    expect(db.calls[0]?.values).toEqual([
      "r1",
      "rejected",
      "admin",
      reviewedAt.toISOString(),
      "资料不完整",
    ]);
  });

  it("returns null for unknown requests", async () => {
    const db = new FakeQueryable([[]]);
    const repository = new PostgresJoinRequestRepository(db);
    await expect(repository.findById("missing")).resolves.toBeNull();
  });
});
