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
      /not open/u,
    );
  });

  it("enforces capacity", () => {
    service.createActivity({ groupId: "g1", title: "限额活动", createdBy: "admin", capacity: 1, activityId: "a1" });
    service.openActivity("a1");
    service.register({ activityId: "a1", userId: "u1" });
    expect(() => service.register({ activityId: "a1", userId: "u2" })).toThrow(
      /full/u,
    );
  });

  it("rejects duplicate registration", () => {
    service.createActivity({ groupId: "g1", title: "活动", createdBy: "admin", activityId: "a1" });
    service.openActivity("a1");
    service.register({ activityId: "a1", userId: "u1" });
    expect(() => service.register({ activityId: "a1", userId: "u1" })).toThrow(
      /duplicate/u,
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
      /not open/u,
    );
  });

  it("filters activities by group", () => {
    service.createActivity({ groupId: "g1", title: "活动1", createdBy: "admin", activityId: "a1" });
    service.createActivity({ groupId: "g2", title: "活动2", createdBy: "admin", activityId: "a2" });
    expect(service.listActivities("g1").map((activity) => activity.activityId)).toEqual(["a1"]);
  });
});
