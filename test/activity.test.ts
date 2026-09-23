import { describe, expect, it, beforeEach } from "vitest";

import { ActivityStatus } from "../src/core/enums.js";
import { ActivityService } from "../src/services/activity.js";

describe("ActivityService", () => {
  let service: ActivityService;

  beforeEach(() => {
    service = new ActivityService();
  });

  it("creates draft activities", () => {
    const activity = service.createActivity({
      groupId: "g1",
      title: "周末活动",
      createdBy: "admin",
      activityId: "a1",
    });
    expect(activity.status).toBe(ActivityStatus.Draft);
    expect(activity.groupId).toBe("g1");
    expect(service.getActivity("a1")).toEqual(activity);
  });

  it("opens and accepts registrations", () => {
    service.createActivity({ groupId: "g1", title: "周末活动", createdBy: "admin", activityId: "a1" });
    service.openActivity("a1");
    const registration = service.register({ activityId: "a1", userId: "u1", displayName: "小明" });
    expect(registration.groupId).toBe("g1");
    expect(service.listRegistrations("a1")).toEqual([registration]);
  });

  it("requires open activity", () => {
    service.createActivity({ groupId: "g1", title: "周末活动", createdBy: "admin", activityId: "a1" });
    expect(() => service.register({ activityId: "a1", userId: "u1" })).toThrow(
      /活动未开放报名/u,
    );
  });

  it("enforces capacity", () => {
    service.createActivity({ groupId: "g1", title: "限额活动", createdBy: "admin", capacity: 1, activityId: "a1" });
    service.openActivity("a1");
    service.register({ activityId: "a1", userId: "u1" });
    expect(() => service.register({ activityId: "a1", userId: "u2" })).toThrow(
      /名额已满/u,
    );
  });

  it("rejects duplicate registration", () => {
    service.createActivity({ groupId: "g1", title: "活动", createdBy: "admin", activityId: "a1" });
    service.openActivity("a1");
    service.register({ activityId: "a1", userId: "u1" });
    expect(() => service.register({ activityId: "a1", userId: "u1" })).toThrow(
      /已经报名/u,
    );
  });

  it("cancels registration", () => {
    service.createActivity({ groupId: "g1", title: "活动", createdBy: "admin", activityId: "a1" });
    service.openActivity("a1");
    service.register({ activityId: "a1", userId: "u1", registrationId: "r1" });
    service.cancelRegistration("r1", "u1");
    expect(service.listRegistrations("a1")).toEqual([]);
  });

  it("blocks registration after cancellation", () => {
    service.createActivity({ groupId: "g1", title: "活动", createdBy: "admin", activityId: "a1" });
    service.cancelActivity("a1");
    expect(() => service.register({ activityId: "a1", userId: "u1" })).toThrow(
      /活动未开放报名/u,
    );
  });

  it("filters activities by group", () => {
    service.createActivity({ groupId: "g1", title: "活动1", createdBy: "admin", activityId: "a1" });
    service.createActivity({ groupId: "g2", title: "活动2", createdBy: "admin", activityId: "a2" });
    expect(service.listActivities("g1").map((activity) => activity.activityId)).toEqual(["a1"]);
  });

  it("generates a short code and resolves it (with # and any case)", () => {
    const activity = service.createActivity({
      groupId: "g1",
      title: "活动",
      createdBy: "admin",
      activityId: "a1",
      code: "M7K2Q9",
    });
    expect(activity.code).toBe("M7K2Q9");
    expect(service.findByCode("#M7K2Q9")?.activityId).toBe("a1");
    expect(service.findByCode("m7k2q9")?.activityId).toBe("a1");
    expect(service.findByCode("ZZZZZZ")).toBeUndefined();
  });

  it("updates links and restrictions", () => {
    service.createActivity({ groupId: "g1", title: "活动", createdBy: "admin", activityId: "a1" });
    const updated = service.updateActivity("a1", {
      links: [{ label: "报名链接", url: "https://example.com" }],
      allowYears: ["22", "23"],
      denyColleges: ["环境科学与工程学院"],
      capacity: 30,
    });
    expect(updated.links[0]?.url).toBe("https://example.com");
    expect(updated.allowYears).toEqual(["22", "23"]);
    expect(updated.denyColleges).toEqual(["环境科学与工程学院"]);
    expect(updated.capacity).toBe(30);
  });

  it("enforces allow/deny rules for colleges and years", () => {
    service.createActivity({
      groupId: "g1",
      title: "限定活动",
      createdBy: "admin",
      activityId: "a1",
      allowYears: ["23"],
      denyColleges: ["化学与生命科学学院"],
    });
    const activity = service.getActivity("a1");
    const profile = {
      userId: "u1",
      name: "小明",
      studentId: "23123456789",
      className: "材化2211",
      college: "化学与生命科学学院",
      year: "2023",
    };

    // 黑名单优先
    expect(() => service.checkEligibility(activity, profile)).toThrow(
      /不接受/u,
    );

    // 学院不在黑名单但不是白名单年级
    const otherCollege = { ...profile, college: "环境科学与工程学院" };
    expect(() => service.checkEligibility(activity, otherCollege)).not.toThrow();

    const wrongYear = { ...otherCollege, studentId: "22123456789", year: "2022" };
    expect(() => service.checkEligibility(activity, wrongYear)).toThrow(/仅限/u);
  });

  it("matches allowed colleges by partial name", () => {
    const activity = service.createActivity({
      groupId: "g1",
      title: "活动",
      createdBy: "admin",
      activityId: "a1",
      allowColleges: ["环境"],
    });
    const profile = {
      userId: "u1",
      name: "小明",
      studentId: "24123456789",
      className: "环工2414",
      college: "环境科学与工程学院",
      year: "2024",
    };
    expect(() => service.checkEligibility(activity, profile)).not.toThrow();
  });
});
