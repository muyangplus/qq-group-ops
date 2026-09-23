import { randomUUID } from "node:crypto";

import { ActivityStatus } from "../core/enums.js";
import { utcNow } from "../core/models.js";
import type { ActivityRepository } from "../db/activityRepository.js";
import type { ActivityDetailsRepository } from "../db/activityDetailsRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import { randomBase62 } from "./shortCodes.js";
import type { UserProfile } from "./userProfiles.js";

export const ACTIVITY_CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 20;

export interface ActivityLink {
  label: string;
  url: string;
}

export interface ActivityRules {
  allowColleges: string[];
  denyColleges: string[];
  allowYears: string[];
  denyYears: string[];
}

export interface Activity {
  activityId: string;
  /** 6 位随机 Base62 短码（展示为 `#A7K2Q9`）。 */
  code: string;
  groupId: string;
  /** 展示用群号（可选，便于在卡片里写明活动群）。 */
  groupNumber: string;
  title: string;
  createdBy: string;
  description: string;
  links: ActivityLink[];
  capacity?: number;
  allowColleges: string[];
  denyColleges: string[];
  allowYears: string[];
  denyYears: string[];
  status: ActivityStatus;
  createdAt: Date;
}

export interface ActivityDetails {
  activityId: string;
  code: string;
  groupNumber: string;
  links: ActivityLink[];
  rules: ActivityRules;
}

export interface ActivityRegistration {
  registrationId: string;
  activityId: string;
  groupId: string;
  userId: string;
  displayName: string;
  note: string;
  createdAt: Date;
}

export interface CreateActivityInput {
  groupId: string;
  title: string;
  createdBy: string;
  description?: string;
  capacity?: number;
  activityId?: string;
  code?: string;
  groupNumber?: string;
  links?: ActivityLink[];
  allowColleges?: string[];
  denyColleges?: string[];
  allowYears?: string[];
  denyYears?: string[];
}

export interface UpdateActivityInput {
  title?: string;
  description?: string;
  capacity?: number | undefined;
  groupNumber?: string;
  links?: ActivityLink[];
  allowColleges?: string[];
  denyColleges?: string[];
  allowYears?: string[];
  denyYears?: string[];
}

export interface RegisterActivityInput {
  activityId: string;
  userId: string;
  displayName?: string;
  note?: string;
  registrationId?: string;
}

export class ActivityRuleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActivityRuleError";
  }
}

export interface ActivityEligibility {
  studentId: string;
  className: string;
  college: string;
  year: string;
}

/**
 * 活动模块：发布 / 报名 / 管理。
 *
 * - 活动归属一个群（`groupId`），可另外记一个展示用群号；
 * - 每个活动有随机 Base62 短码（`code`），用户用 `#A7K2Q9` 报名与管理；
 * - 报名限制：学院/年级白名单 + 黑名单（黑名单优先），年级取学号前两位 22-26；
 * - 额外字段（链接、限制）存在独立的 `activity_details` 表，老库升级无需 ALTER。
 */
export class ActivityService {
  private readonly activities = new Map<string, Activity>();
  private readonly registrations = new Map<string, ActivityRegistration>();
  private readonly repository: ActivityRepository | undefined;
  private readonly detailsRepository: ActivityDetailsRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly generateCode: () => string;

  public constructor(
    repository?: ActivityRepository,
    queue?: WriteQueue,
    detailsRepository?: ActivityDetailsRepository,
    options: { generateCode?: () => string } = {},
  ) {
    this.repository = repository;
    this.detailsRepository = detailsRepository;
    this.queue =
      repository || detailsRepository ? (queue ?? new WriteQueue()) : undefined;
    this.generateCode =
      options.generateCode ??
      (() => randomBase62(ACTIVITY_CODE_LENGTH));
  }

  public get persistent(): boolean {
    return this.repository !== undefined || this.detailsRepository !== undefined;
  }

  public async load(): Promise<void> {
    const [activities, registrations, details] = await Promise.all([
      this.repository?.findActivities() ?? Promise.resolve([]),
      this.repository?.findRegistrations() ?? Promise.resolve([]),
      this.detailsRepository?.findAll() ?? Promise.resolve([]),
    ]);
    this.activities.clear();
    this.registrations.clear();
    for (const activity of activities) {
      this.activities.set(activity.activityId, activity);
    }
    for (const detail of details) {
      const activity = this.activities.get(detail.activityId);
      if (activity) {
        this.activities.set(detail.activityId, applyDetails(activity, detail));
      }
    }
    for (const registration of registrations) {
      this.registrations.set(registration.registrationId, registration);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public createActivity(input: CreateActivityInput): Activity {
    if (input.title.trim().length === 0) {
      throw new Error("activity title must not be empty");
    }
    if (input.capacity !== undefined && input.capacity <= 0) {
      throw new Error("activity capacity must be positive");
    }
    const activityId = input.activityId ?? randomUUID();
    if (this.activities.has(activityId)) {
      throw new Error(`duplicate activity id: ${activityId}`);
    }
    const activity: Activity = {
      activityId,
      code: input.code ?? this.nextCode(),
      groupId: input.groupId,
      groupNumber: input.groupNumber?.trim() ?? "",
      title: input.title.trim(),
      createdBy: input.createdBy,
      description: input.description ?? "",
      links: [...(input.links ?? [])],
      ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      allowColleges: [...(input.allowColleges ?? [])],
      denyColleges: [...(input.denyColleges ?? [])],
      allowYears: [...(input.allowYears ?? [])],
      denyYears: [...(input.denyYears ?? [])],
      status: ActivityStatus.Draft,
      createdAt: utcNow(),
    };
    this.activities.set(activityId, activity);
    this.persist(activity);
    return { ...activity };
  }

  public getActivity(activityId: string): Activity {
    const activity = this.activities.get(activityId);
    if (!activity) {
      throw new Error(`activity not found: ${activityId}`);
    }
    return cloneActivity(activity);
  }

  /** 按短码查找（接受 `#A7K2Q9` 或 `A7K2Q9`，大小写不敏感）。 */
  public findByCode(code: string): Activity | undefined {
    const trimmed = code.trim().replace(/^#/u, "").toLowerCase();
    if (trimmed.length === 0) {
      return undefined;
    }
    for (const activity of this.activities.values()) {
      if (activity.code.toLowerCase() === trimmed) {
        return cloneActivity(activity);
      }
    }
    return undefined;
  }

  public requireByCode(code: string): Activity {
    const activity = this.findByCode(code);
    if (!activity) {
      throw new Error(`活动不存在：${code}`);
    }
    return activity;
  }

  public listActivities(groupId: string): Activity[] {
    return [...this.activities.values()]
      .filter((activity) => activity.groupId === groupId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map(cloneActivity);
  }

  public updateActivity(
    activityId: string,
    patch: UpdateActivityInput,
  ): Activity {
    const activity = this.getActivity(activityId);
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length === 0) {
        throw new Error("activity title must not be empty");
      }
      activity.title = title;
    }
    if (patch.description !== undefined) {
      activity.description = patch.description.trim();
    }
    if (patch.groupNumber !== undefined) {
      activity.groupNumber = patch.groupNumber.trim();
    }
    if (patch.links !== undefined) {
      activity.links = [...patch.links];
    }
    if (patch.capacity !== undefined) {
      if (patch.capacity !== undefined && patch.capacity <= 0) {
        throw new Error("activity capacity must be positive");
      }
      if (patch.capacity === undefined) {
        delete activity.capacity;
      } else {
        activity.capacity = patch.capacity;
      }
    }
    if (patch.allowColleges !== undefined) {
      activity.allowColleges = normalizeList(patch.allowColleges);
    }
    if (patch.denyColleges !== undefined) {
      activity.denyColleges = normalizeList(patch.denyColleges);
    }
    if (patch.allowYears !== undefined) {
      activity.allowYears = normalizeList(patch.allowYears);
    }
    if (patch.denyYears !== undefined) {
      activity.denyYears = normalizeList(patch.denyYears);
    }
    this.activities.set(activityId, activity);
    this.persist(activity);
    return cloneActivity(activity);
  }

  public openActivity(activityId: string): Activity {
    return this.setStatus(activityId, ActivityStatus.Open);
  }

  public closeActivity(activityId: string): Activity {
    return this.setStatus(activityId, ActivityStatus.Closed);
  }

  public cancelActivity(activityId: string): Activity {
    return this.setStatus(activityId, ActivityStatus.Cancelled);
  }

  /**
   * 报名资格校验：黑名单优先，然后白名单（空 = 不限）。
   *
   * 年级取学号前两位（22-26），学院来自个人资料（可由班级库自动带出）。
   */
  public checkEligibility(
    activity: Activity,
    profile: UserProfile,
  ): ActivityEligibility {
    const studentId = profile.studentId;
    const year = studentYear(studentId);
    const college = profile.college;
    const yearLabel = `20${year}`;

    if (activity.denyYears.includes(year) || activity.denyYears.includes(yearLabel)) {
      throw new ActivityRuleError(`本活动不接受 ${yearLabel} 级报名`);
    }
    if (activity.denyColleges.length > 0 && college.length > 0 && matchesCollege(activity.denyColleges, college)) {
      throw new ActivityRuleError(`本活动不接受「${college}」的同学报名`);
    }
    if (activity.allowYears.length > 0) {
      const allowed = activity.allowYears.some(
        (value) => value === year || value === yearLabel,
      );
      if (!allowed) {
        throw new ActivityRuleError(
          `本活动仅限 ${activity.allowYears.join(" / ")} 级报名（你的年级：${year}）`,
        );
      }
    }
    if (activity.allowColleges.length > 0) {
      if (college.length === 0) {
        throw new ActivityRuleError(
          "本活动限学院报名，请先用 /profile set college <学院> 补全学院",
        );
      }
      if (!matchesCollege(activity.allowColleges, college)) {
        throw new ActivityRuleError(
          `本活动仅限 ${activity.allowColleges.join(" / ")} 报名（你的学院：${college}）`,
        );
      }
    }
    return { studentId, className: profile.className, college, year };
  }

  public register(input: RegisterActivityInput): ActivityRegistration {
    const activity = this.getActivity(input.activityId);
    if (activity.status !== ActivityStatus.Open) {
      throw new ActivityRuleError(`活动未开放报名：${activity.title}`);
    }
    const current = this.listRegistrations(input.activityId);
    if (activity.capacity !== undefined && current.length >= activity.capacity) {
      throw new ActivityRuleError(`活动名额已满（${activity.capacity} 人）`);
    }
    if (current.some((registration) => registration.userId === input.userId)) {
      throw new ActivityRuleError("你已经报名过该活动了");
    }
    const registrationId = input.registrationId ?? randomUUID();
    if (this.registrations.has(registrationId)) {
      throw new Error(`duplicate registration id: ${registrationId}`);
    }
    const registration: ActivityRegistration = {
      registrationId,
      activityId: input.activityId,
      groupId: activity.groupId,
      userId: input.userId,
      displayName: input.displayName ?? "",
      note: input.note ?? "",
      createdAt: utcNow(),
    };
    this.registrations.set(registrationId, registration);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("activity.registration.save", () =>
        repository.saveRegistration(registration),
      );
    }
    return { ...registration };
  }

  public listRegistrations(activityId: string): ActivityRegistration[] {
    return [...this.registrations.values()]
      .filter((registration) => registration.activityId === activityId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((registration) => ({ ...registration }));
  }

  public findRegistration(
    activityId: string,
    userId: string,
  ): ActivityRegistration | undefined {
    const registration = [...this.registrations.values()].find(
      (item) => item.activityId === activityId && item.userId === userId,
    );
    return registration ? { ...registration } : undefined;
  }

  public cancelRegistration(
    registrationId: string,
    userId: string,
  ): ActivityRegistration {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      throw new Error(`registration not found: ${registrationId}`);
    }
    if (registration.userId !== userId) {
      throw new Error("cannot cancel another user's registration");
    }
    this.registrations.delete(registrationId);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("activity.registration.delete", () =>
        repository.deleteRegistration(registrationId),
      );
    }
    return { ...registration };
  }

  private nextCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = this.generateCode();
      if (!this.findByCode(code)) {
        return code;
      }
    }
    throw new Error("活动短码生成失败：连续碰撞");
  }

  private setStatus(activityId: string, status: ActivityStatus): Activity {
    const activity = this.getActivity(activityId);
    const updated: Activity = { ...activity, status };
    this.activities.set(activityId, updated);
    this.persist(updated);
    return cloneActivity(updated);
  }

  private persist(activity: Activity): void {
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("activity.save", () => repository.saveActivity(activity));
    }
    const detailsRepository = this.detailsRepository;
    if (detailsRepository) {
      const details = detailsOf(activity);
      this.queue?.enqueue("activity.details.save", () =>
        detailsRepository.save(details),
      );
    }
  }
}

/** 学号前两位 → 年级（`22`）；无效时抛业务错误。 */
export function studentYear(studentId: string): string {
  const trimmed = studentId.trim();
  if (!/^\d{11}$/u.test(trimmed)) {
    throw new ActivityRuleError("个人资料里的学号不是 11 位，请用 /profile set id 重新填写");
  }
  return trimmed.slice(0, 2);
}

export function detailsOf(activity: Activity): ActivityDetails {
  return {
    activityId: activity.activityId,
    code: activity.code,
    groupNumber: activity.groupNumber,
    links: activity.links.map((link) => ({ ...link })),
    rules: {
      allowColleges: [...activity.allowColleges],
      denyColleges: [...activity.denyColleges],
      allowYears: [...activity.allowYears],
      denyYears: [...activity.denyYears],
    },
  };
}

function applyDetails(activity: Activity, details: ActivityDetails): Activity {
  return {
    ...activity,
    code: details.code,
    groupNumber: details.groupNumber,
    links: details.links.map((link) => ({ ...link })),
    allowColleges: [...details.rules.allowColleges],
    denyColleges: [...details.rules.denyColleges],
    allowYears: [...details.rules.allowYears],
    denyYears: [...details.rules.denyYears],
  };
}

function cloneActivity(activity: Activity): Activity {
  return {
    ...activity,
    links: activity.links.map((link) => ({ ...link })),
    allowColleges: [...activity.allowColleges],
    denyColleges: [...activity.denyColleges],
    allowYears: [...activity.allowYears],
    denyYears: [...activity.denyYears],
  };
}

function normalizeList(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  return result;
}

/** 学院匹配：完全相等或互为子串（允许「环境」匹配「环境科学与工程学院」）。 */
function matchesCollege(list: readonly string[], college: string): boolean {
  return list.some(
    (value) =>
      value === college || college.includes(value) || value.includes(college),
  );
}
