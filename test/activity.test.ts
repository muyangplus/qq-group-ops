import { describe, expect, it, beforeEach } from "vitest";

import { ActivityStatus } from "../src/core/enums.js";
import type {
  ActivityDetails,
  ActivityDetailsRepository,
} from "../src/db/activityDetailsRepository.js";
import type {
  Activity,
  ActivityRegistration,
  ActivityRepository,
} from "../src/services/activity.js";
import { ActivityService } from "../src/services/activity.js";

class FakeActivityRepository implements ActivityRepository {
  public readonly activities: Activity[] = [];
  public readonly registrations: ActivityRegistration[] = [];

  public async saveActivity(activity: Activity): Promise<void> {
    const index = this.activities.findIndex(
      (item) => item.activityId === activity.activityId,
    );
    if (index >= 0) {
      this.activities[index] = { ...activity };
    } else {
      this.activities.push({ ...activity });
    }
  }

  public async findActivities(): Promise<Activity[]> {
    return this.activities.map((activity) => ({ ...activity }));
  }

  public async saveRegistration(
    registration: ActivityRegistration,
  ): Promise<void> {
    const index = this.registrations.findIndex(
      (item) => item.registrationId === registration.registrationId,
    );
    if (index >= 0) {
      this.registrations[index] = { ...registration };
    } else {
      this.registrations.push({ ...registration });
    }
  }

  public async deleteRegistration(registrationId: string): Promise<void> {
    const index = this.registrations.findIndex(
      (item) => item.registrationId === registrationId,
    );
    if (index >= 0) {
      this.registrations.splice(index, 1);
    }
  }

  public async findRegistrations(): Promise<ActivityRegistration[]> {
    return this.registrations.map((registration) => ({ ...registration }));
  }
}

class FakeActivityDetailsRepository implements ActivityDetailsRepository {
  public readonly rows: ActivityDetails[] = [];

  public async findAll(): Promise<ActivityDetails[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  public async save(details: ActivityDetails): Promise<void> {
    const index = this.rows.findIndex(
      (row) => row.activityId === details.activityId,
    );
    if (index >= 0) {
      this.rows[index] = { ...details };
    } else {
      this.rows.push({ ...details });
    }
  }
}

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
      year: "23",
    };

    // 黑名单优先
    expect(() => service.checkEligibility(activity, profile)).toThrow(
      /不接受/u,
    );

    // 学院不在黑名单但不是白名单年级
    const otherCollege = { ...profile, college: "环境科学与工程学院" };
    expect(() => service.checkEligibility(activity, otherCollege)).not.toThrow();

    const wrongYear = { ...otherCollege, studentId: "22123456789", year: "22" };
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
      year: "24",
    };
    expect(() => service.checkEligibility(activity, profile)).not.toThrow();
  });

  it("regenerates legacy lowercase activity codes on load", async () => {
    const activities = new FakeActivityRepository();
    const details = new FakeActivityDetailsRepository();
    const first = new ActivityService(activities, undefined, details);
    first.createActivity({
      groupId: "g1",
      title: "活动",
      createdBy: "admin",
      activityId: "a1",
      code: "Ab12Cd",
    });
    await first.flush();
    expect(details.rows[0]?.code).toBe("Ab12Cd");

    // 重启：含小写的短码换成数字 + 大写，并写回数据库
    const restarted = new ActivityService(activities, undefined, details, {
      generateCode: () => "Z9Y8X7",
    });
    await restarted.load();
    await restarted.flush();

    expect(restarted.findByCode("#Z9Y8X7")?.activityId).toBe("a1");
    expect(restarted.findByCode("#Ab12Cd")).toBeUndefined();
    expect(details.rows[0]?.code).toBe("Z9Y8X7");
  });

  it("treats four-digit allowed years as legacy values", () => {
    const activity = service.createActivity({
      groupId: "g1",
      title: "活动",
      createdBy: "admin",
      activityId: "a1",
      allowYears: ["2023"],
    });
    const profile = {
      userId: "u1",
      name: "小明",
      studentId: "23123456789",
      className: "材化2211",
      college: "化学与生命科学学院",
      year: "23",
    };
    // 历史配置写成四位时仍然能命中两位数年级
    expect(() => service.checkEligibility(activity, profile)).not.toThrow();

    const wrong = { ...profile, studentId: "22123456789", year: "22" };
    expect(() => service.checkEligibility(activity, wrong)).toThrow(/仅限/u);
  });
});
