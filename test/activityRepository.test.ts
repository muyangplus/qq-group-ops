import { describe, expect, it } from "vitest";

import { utcNow } from "../src/core/models.js";
import { SqlActivityRepository } from "../src/db/activityRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("SqlActivityRepository", () => {
  it("upserts activities", async () => {
    const db = new FakeQueryable();
    const repository = new SqlActivityRepository(db);
    const createdAt = utcNow();

    await repository.saveActivity({
      activityId: "a1",
      code: "ABC123",
      groupId: "g1",
      groupNumber: "",
      title: "周末活动",
      createdBy: "admin",
      description: "",
      links: [],
      capacity: 2,
      allowColleges: [],
      denyColleges: [],
      allowYears: [],
      denyYears: [],
      status: "draft",
      createdAt,
    });

    expect(db.calls[0]?.text).toContain("INSERT INTO activities");
    expect(db.calls[0]?.text).toContain("ON CONFLICT (activity_id)");
    expect(db.calls[0]?.values).toEqual([
      "a1",
      "g1",
      "周末活动",
      "admin",
      "",
      2,
      "draft",
      createdAt.toISOString(),
    ]);
  });

  it("maps activity rows and omits a missing capacity", async () => {
    const db = new FakeQueryable([
      [
        {
          activity_id: "a1",
          group_id: "g1",
          title: "周末活动",
          created_by: "admin",
          description: "",
          capacity: null,
          status: "open",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);
    const repository = new SqlActivityRepository(db);

    await expect(repository.findActivities()).resolves.toEqual([
      {
        activityId: "a1",
        code: "",
        groupId: "g1",
        groupNumber: "",
        title: "周末活动",
        createdBy: "admin",
        description: "",
        links: [],
        allowColleges: [],
        denyColleges: [],
        allowYears: [],
        denyYears: [],
        // 新增的活动选项由 activity_settings 表合并，行映射阶段给默认值
        mentionAll: false,
        notifyCreator: false,
        status: "open",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("saves and deletes registrations", async () => {
    const db = new FakeQueryable();
    const repository = new SqlActivityRepository(db);
    const createdAt = utcNow();

    await repository.saveRegistration({
      registrationId: "r1",
      activityId: "a1",
      groupId: "g1",
      userId: "u1",
      displayName: "小明",
      note: "",
      createdAt,
    });
    await repository.deleteRegistration("r1");

    expect(db.calls[0]?.text).toContain("INSERT INTO activity_registrations");
    expect(db.calls[0]?.values).toEqual([
      "r1",
      "a1",
      "g1",
      "u1",
      "小明",
      "",
      createdAt.toISOString(),
    ]);
    expect(db.calls[1]?.text).toContain("DELETE FROM activity_registrations");
    expect(db.calls[1]?.values).toEqual(["r1"]);
  });

  it("maps registration rows", async () => {
    const db = new FakeQueryable([
      [
        {
          registration_id: "r1",
          activity_id: "a1",
          group_id: "g1",
          user_id: "u1",
          display_name: "小明",
          note: "无",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);
    const repository = new SqlActivityRepository(db);

    await expect(repository.findRegistrations()).resolves.toEqual([
      {
        registrationId: "r1",
        activityId: "a1",
        groupId: "g1",
        userId: "u1",
        displayName: "小明",
        note: "无",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
  });
});
