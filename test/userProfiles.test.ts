import { describe, expect, it, beforeEach } from "vitest";

import type { UserProfileRepository } from "../src/db/userProfileRepository.js";
import { MemberRoster } from "../src/services/memberRoster.js";
import {
  UserProfileError,
  UserProfileService,
  normalizeYear,
  yearFromStudentId,
  type UserProfile,
} from "../src/services/userProfiles.js";

class FakeUserProfileRepository implements UserProfileRepository {
  public readonly rows = new Map<string, UserProfile>();

  public async findAll(): Promise<UserProfile[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  public async save(profile: UserProfile): Promise<void> {
    this.rows.set(profile.userId, { ...profile });
  }

  public async remove(userId: string): Promise<void> {
    this.rows.delete(userId);
  }
}

function roster(): MemberRoster {
  return MemberRoster.fromIndex({
    classes: ["环工2414", "材化2211"],
    majors: ["环境工程", "材料化学"],
    classInfo: {
      环工2414: {
        major: "环境工程",
        college: "环境科学与工程学院",
        year: "2024",
      },
      材化2211: { major: "材料化学", college: "化学与生命科学学院", year: "2022" },
    },
  });
}

describe("UserProfileService", () => {
  let service: UserProfileService;

  beforeEach(() => {
    service = new UserProfileService();
    service.setRoster(roster());
  });

  it("derives the year from the 11-digit student id", () => {
    expect(yearFromStudentId("22123456789")).toBe("2022");
    expect(yearFromStudentId("26123456789")).toBe("2026");
    expect(() => yearFromStudentId("2022123456")).toThrow(UserProfileError);
    expect(() => yearFromStudentId("20123456789")).toThrow(/前两位/u);
    expect(normalizeYear("23")).toBe("2023");
    expect(normalizeYear("2024")).toBe("2024");
  });

  it("fills the college automatically from the class library", () => {
    service.set("u1", "name", "小明");
    service.set("u1", "studentId", "24123456789");
    const profile = service.set("u1", "className", "环工2414");

    expect(profile.name).toBe("小明");
    expect(profile.year).toBe("2024");
    expect(profile.college).toBe("环境科学与工程学院");
    expect(service.requireComplete("u1").className).toBe("环工2414");
  });

  it("allows overriding college and year", () => {
    service.set("u1", "studentId", "22123456789");
    service.set("u1", "className", "环工2414");
    service.set("u1", "college", "计算机学院");
    const profile = service.set("u1", "year", "22");

    expect(profile.college).toBe("计算机学院");
    expect(profile.year).toBe("2022");
  });

  it("rejects classes outside the class library", () => {
    expect(() => service.set("u1", "className", "不存在的班级")).toThrow(
      /不在班级库/u,
    );
  });

  it("refuses to set a class when the roster is not loaded", () => {
    const noRoster = new UserProfileService();
    expect(() => noRoster.set("u1", "className", "环工2414")).toThrow(
      /班级库未加载/u,
    );
  });

  it("requires a complete profile for signup", () => {
    expect(() => service.requireComplete("u1")).toThrow(/个人资料/u);
    service.set("u1", "studentId", "22123456789");
    expect(() => service.requireComplete("u1")).toThrow(/个人资料/u);
  });

  it("persists profiles and restores them after a restart", async () => {
    const repository = new FakeUserProfileRepository();
    const first = new UserProfileService(repository);
    first.setRoster(roster());
    first.set("u1", "name", "小明");
    first.set("u1", "studentId", "22123456789");
    first.set("u1", "className", "材化2211");
    await first.flush();

    const restarted = new UserProfileService(repository);
    await restarted.load();
    const profile = restarted.get("u1");
    expect(profile).toMatchObject({
      name: "小明",
      studentId: "22123456789",
      className: "材化2211",
      college: "化学与生命科学学院",
      year: "2022",
    });
  });

  it("clears a single field or the whole profile", () => {
    service.set("u1", "name", "小明");
    service.set("u1", "studentId", "22123456789");
    const cleared = service.clear("u1", "name");
    expect(cleared?.name).toBe("");
    expect(cleared?.studentId).toBe("22123456789");
    expect(service.clear("u1")).toBeUndefined();
    expect(service.get("u1")).toBeUndefined();
  });
});
