import { getLogger } from "../core/logger.js";
import type { UserProfileRepository } from "../db/userProfileRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import type { MemberRoster } from "./memberRoster.js";

const log = getLogger("user-profiles");

/** 允许的入学年级（学号前两位）：22-26 级。 */
export const PROFILE_ENTRY_YEARS = ["22", "23", "24", "25", "26"] as const;

export type UserProfileField =
  | "name"
  | "studentId"
  | "className"
  | "college"
  | "year";

export interface UserProfile {
  userId: string;
  name: string;
  /** 11 位学号。 */
  studentId: string;
  className: string;
  college: string;
  /** 入学年级，**两位**，如 `22`（由学号前两位推导，可用 `/profile set year 22` 覆盖）。 */
  year: string;
}

export class UserProfileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UserProfileError";
  }
}

/** 学号前两位 → 年级（两位）；不合法时抛错。 */
export function yearFromStudentId(studentId: string): string {
  const trimmed = studentId.trim();
  if (!/^\d{11}$/u.test(trimmed)) {
    throw new UserProfileError("学号必须是 11 位数字，例如 22123456789");
  }
  const prefix = trimmed.slice(0, 2);
  if (!(PROFILE_ENTRY_YEARS as readonly string[]).includes(prefix)) {
    throw new UserProfileError(
      `学号前两位必须是 ${PROFILE_ENTRY_YEARS.join(" / ")}（当前在校年级），收到：${prefix}`,
    );
  }
  return prefix;
}

/**
 * 年级规范化：**只接受两位**（`22`），不接受四位完整年份（`2022`）。
 *
 * 存储与展示都用两位，和班级库 `njmc`（四位）在写入时做转换，避免同一语义两种写法。
 */
export function normalizeYear(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}$/u.test(trimmed)) {
    throw new UserProfileError(
      `年级只写两位，如 ${PROFILE_ENTRY_YEARS.join(" / ")}（不要写 ${trimmed} 这种四位年份）`,
    );
  }
  if (!(PROFILE_ENTRY_YEARS as readonly string[]).includes(trimmed)) {
    throw new UserProfileError(
      `年级必须是两位：${PROFILE_ENTRY_YEARS.join(" / ")}`,
    );
  }
  return trimmed;
}

/** 四位年份 → 两位年级（`2022` → `22`）；已经是两位则原样返回。 */
export function toShortYear(value: string): string {
  const trimmed = value.trim();
  return /^\d{4}$/u.test(trimmed) ? trimmed.slice(2) : trimmed;
}

/**
 * 个人资料（班级 / 学院 / 姓名 / 学号）。
 *
 * 规则（用户确认）：
 * - 学号必须 11 位，前两位 22-26 决定年级；
 * - 班级必须存在于 `data/class-index.json`，学院由班级库自动带出，允许手动覆盖；
 * - 全部字段持久化到 `user_profiles`，重启不丢。
 */
export class UserProfileService {
  private readonly profiles = new Map<string, UserProfile>();
  private readonly repository: UserProfileRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private roster: MemberRoster | undefined;

  public constructor(repository?: UserProfileRepository, queue?: WriteQueue) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public setRoster(roster: MemberRoster | undefined): void {
    this.roster = roster;
  }

  public get rosterAvailable(): boolean {
    return this.roster !== undefined;
  }

  /** 只读暴露班级库，供智能解析等外部逻辑复用。 */
  public get rosterRef(): MemberRoster | undefined {
    return this.roster;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const profiles = await this.repository.findAll();
    this.profiles.clear();
    for (const profile of profiles) {
      // 兼容历史数据：早期版本把年份存成四位（2022），统一收敛成两位（22）
      const year = toShortYear(profile.year);
      const normalized: UserProfile = { ...profile, year };
      this.profiles.set(normalized.userId, normalized);
      if (year !== profile.year) {
        this.queue?.enqueue("user-profile.save", () =>
          this.repository!.save(normalized),
        );
      }
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public get(userId: string): UserProfile | undefined {
    const profile = this.profiles.get(userId);
    return profile ? { ...profile } : undefined;
  }

  public list(): UserProfile[] {
    return [...this.profiles.values()]
      .map((profile) => ({ ...profile }))
      .sort((left, right) => left.userId.localeCompare(right.userId));
  }

  /** 报名等场景要求资料完整：姓名 + 学号 + 班级。 */
  public requireComplete(userId: string): UserProfile {
    const profile = this.get(userId);
    if (!profile || !profile.name || !profile.studentId || !profile.className) {
      throw new UserProfileError(
        "请先补全个人资料：/profile set name <姓名>、/profile set id <11位学号>、/profile set class <班级>",
      );
    }
    return profile;
  }

  /**
   * 更新单个字段；返回更新后的完整资料。
   *
   * 班级会自动带出学院，学号会自动带出年级，之后都可以手动覆盖。
   */
  public set(userId: string, field: UserProfileField, value: string): UserProfile {
    const current: UserProfile = this.profiles.get(userId) ?? {
      userId,
      name: "",
      studentId: "",
      className: "",
      college: "",
      year: "",
    };
    const next: UserProfile = { ...current };

    switch (field) {
      case "name": {
        const name = value.replace(/\s+/gu, "").trim();
        if (name.length === 0 || name.length > 20) {
          throw new UserProfileError("姓名需要 1-20 个字符（不含空格）");
        }
        next.name = name;
        break;
      }
      case "studentId": {
        const studentId = value.trim();
        next.year = yearFromStudentId(studentId);
        next.studentId = studentId;
        break;
      }
      case "className": {
        const className = value.trim();
        if (className.length === 0) {
          throw new UserProfileError("班级不能为空");
        }
        const roster = this.roster;
        if (!roster) {
          throw new UserProfileError(
            "班级库未加载，先在服务器执行 pnpm class:index 并重启机器人",
          );
        }
        if (!roster.hasClass(className)) {
          throw new UserProfileError(
            `班级「${className}」不在班级库中，请核对 data/class-index.json 里的 classes`,
          );
        }
        next.className = className;
        const info = roster.infoFor(className);
        if (info) {
          next.college = info.college;
          if (!next.year && info.year) {
            // 班级库里是四位（2022），个人资料统一存两位（22）
            next.year = toShortYear(info.year);
          }
        }
        break;
      }
      case "college": {
        const college = value.trim();
        if (college.length === 0 || college.length > 50) {
          throw new UserProfileError("学院需要 1-50 个字符");
        }
        next.college = college;
        break;
      }
      case "year": {
        next.year = normalizeYear(value);
        break;
      }
    }

    this.profiles.set(userId, next);
    if (this.repository) {
      this.queue?.enqueue("user-profile.save", () => this.repository!.save(next));
    }
    log.debug("profile updated", { userId, field });
    return { ...next };
  }

  /** 清空某个字段（不传 field 则清空整份资料）。 */
  public clear(userId: string, field?: UserProfileField): UserProfile | undefined {
    if (field === undefined) {
      this.profiles.delete(userId);
      if (this.repository) {
        this.queue?.enqueue("user-profile.remove", () =>
          this.repository!.remove(userId),
        );
      }
      log.info("profile cleared", { userId });
      return undefined;
    }
    const current = this.profiles.get(userId);
    if (!current) {
      return undefined;
    }
    const next: UserProfile = { ...current, [field]: "" };
    this.profiles.set(userId, next);
    if (this.repository) {
      this.queue?.enqueue("user-profile.save", () => this.repository!.save(next));
    }
    return { ...next };
  }
}
