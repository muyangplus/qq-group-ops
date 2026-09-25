import { ActivityStatus } from "../core/enums.js";
import { utcNow } from "../core/models.js";
import type { ActivityDetailsRepository } from "../db/activityDetailsRepository.js";
import type { ActivityGroupRepository } from "../db/activityGroupRepository.js";
import type { ActivityRepository } from "../db/activityRepository.js";
import type { ActivitySettingsRepository } from "../db/activitySettingsRepository.js";
import type {
  ActivityWaitlistEntry,
  ActivityWaitlistRepository,
} from "../db/activityWaitlistRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import {
  log,
  ACTIVITY_CODE_LENGTH,
  MAX_CODE_ATTEMPTS,
  Activity,
  ActivityRegistration,
  CreateActivityInput,
  UpdateActivityInput,
  RegisterActivityInput,
  ActivityRuleError,
  ActivityEligibility,
  studentYear,
  detailsOf,
  applyDetails,
  cloneActivity,
  waitlistKey,
  ACTIVITY_SETTING_KEYS,
  applySettings,
  settingsOf,
  normalizeList,
  matchesCollege,
} from "./activityCore.js";
import { randomCode } from "./shortCodes.js";
import type { UserProfile } from "./userProfiles.js";
import { randomUUID } from "node:crypto";

export { ACTIVITY_CODE_LENGTH, ACTIVITY_SETTING_KEYS, ActivityRuleError, detailsOf, settingsOf, studentYear } from "./activityCore.js";
export type { Activity, ActivityDetails, ActivityEligibility, ActivityLink, ActivityRegistration, ActivityRules, ActivityWaitlistEntry, CreateActivityInput, RegisterActivityInput, UpdateActivityInput, WaitlistPromotionMode } from "./activityCore.js";

/**
 * activity 服务主体（类型、常量与纯函数见 activityCore.ts）。
 */

export class ActivityService {
  private readonly activities = new Map<string, Activity>();
  private readonly registrations = new Map<string, ActivityRegistration>();
  private readonly waitlist = new Map<string, ActivityWaitlistEntry>();
  /**
   * 活动 → 绑定群集合（§B4）。
   *
   * `activities.groupId` 是**归属群**（创建地 / 权限依据），这里是**发布与广播的目标群**；
   * 一个活动可以绑定多个群，创建活动会自动绑定创建群。
   */
  private readonly boundGroups = new Map<string, Set<string>>();
  private readonly repository: ActivityRepository | undefined;
  private readonly detailsRepository: ActivityDetailsRepository | undefined;
  private readonly waitlistRepository: ActivityWaitlistRepository | undefined;
  private readonly settingsRepository: ActivitySettingsRepository | undefined;
  private readonly groupRepository: ActivityGroupRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly generateCode: () => string;

  public constructor(
    repository?: ActivityRepository,
    queue?: WriteQueue,
    detailsRepository?: ActivityDetailsRepository,
    options: {
      generateCode?: () => string;
      waitlistRepository?: ActivityWaitlistRepository | undefined;
      settingsRepository?: ActivitySettingsRepository | undefined;
      groupRepository?: ActivityGroupRepository | undefined;
    } = {},
  ) {
    this.repository = repository;
    this.detailsRepository = detailsRepository;
    this.waitlistRepository = options.waitlistRepository;
    this.settingsRepository = options.settingsRepository;
    this.groupRepository = options.groupRepository;
    this.queue =
      repository ||
      detailsRepository ||
      this.waitlistRepository ||
      this.settingsRepository ||
      this.groupRepository
        ? (queue ?? new WriteQueue())
        : undefined;
    this.generateCode =
      options.generateCode ??
      (() => randomCode(ACTIVITY_CODE_LENGTH));
  }

  public get persistent(): boolean {
    return (
      this.repository !== undefined ||
      this.detailsRepository !== undefined ||
      this.waitlistRepository !== undefined ||
      this.settingsRepository !== undefined ||
      this.groupRepository !== undefined
    );
  }

  public async load(): Promise<void> {
    const [activities, registrations, details, waitlist, settings, groups] =
      await Promise.all([
        this.repository?.findActivities() ?? Promise.resolve([]),
        this.repository?.findRegistrations() ?? Promise.resolve([]),
        this.detailsRepository?.findAll() ?? Promise.resolve([]),
        this.waitlistRepository?.findAll() ?? Promise.resolve([]),
        this.settingsRepository?.findAll() ?? Promise.resolve([]),
        this.groupRepository?.findAll() ?? Promise.resolve([]),
      ]);
    this.activities.clear();
    this.registrations.clear();
    this.waitlist.clear();
    this.boundGroups.clear();
    for (const group of groups) {
      this.addGroupBinding(group.activityId, group.groupId);
    }
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
    for (const entry of waitlist) {
      this.waitlist.set(waitlistKey(entry.activityId, entry.userId), entry);
    }
    const settingsByActivity = new Map<string, Map<string, string>>();
    for (const setting of settings) {
      const bucket =
        settingsByActivity.get(setting.activityId) ?? new Map<string, string>();
      bucket.set(setting.key, setting.value);
      settingsByActivity.set(setting.activityId, bucket);
    }
    for (const [activityId, bucket] of settingsByActivity) {
      const activity = this.activities.get(activityId);
      if (activity) {
        this.activities.set(activityId, applySettings(activity, bucket));
      }
    }
    this.regenerateLegacyCodes();
  }

  /**
   * 历史活动短码可能含小写字母；启动时换成「数字 + 大写字母」并写回数据库。
   * 旧短码（已发到群里的卡片/链接）会失效，需重新从活动列表获取（用户确认的选择）。
   */
  private regenerateLegacyCodes(): void {
    for (const activity of [...this.activities.values()]) {
      if (activity.code === activity.code.toUpperCase()) {
        continue;
      }
      const updated: Activity = { ...activity, code: this.nextCode() };
      this.activities.set(updated.activityId, updated);
      this.persist(updated);
      log.info("activity code regenerated to uppercase", {
        activityId: updated.activityId,
      });
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
      mentionAll: input.mentionAll ?? false,
      notifyCreator: input.notifyCreator ?? false,
      waitlistPromotion: input.waitlistPromotion ?? "manual",
      heldSlots: 0,
      ...(input.closeAt !== undefined ? { closeAt: input.closeAt } : {}),
      createdAt: utcNow(),
    };
    this.activities.set(activityId, activity);
    this.persist(activity);
    // 用户确认（§B4）：创建活动**自动绑定创建群**，省掉一次手动绑定。
    this.bindGroup(activityId, activity.groupId);
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

  // ------------------------------------------------- 绑定群（§B4）

  /**
   * 绑定发布 / 广播目标群；重复绑定是幂等空操作（返回 `false`）。
   *
   * 活动必须先存在；`groupId` 为空字符串时抛错，避免写出脏绑定行。
   */
  public bindGroup(activityId: string, groupId: string): boolean {
    this.getActivity(activityId);
    const trimmed = groupId.trim();
    if (trimmed.length === 0) {
      throw new Error("activity group id must not be empty");
    }
    const existing = this.boundGroups.get(activityId);
    if (existing?.has(trimmed)) {
      return false;
    }
    this.addGroupBinding(activityId, trimmed);
    const repository = this.groupRepository;
    if (repository) {
      this.queue?.enqueue("activity.group.save", () =>
        repository.save({ activityId, groupId: trimmed, createdAt: utcNow() }),
      );
    }
    log.info("activity group bound", { activityId, groupId: trimmed });
    return true;
  }

  /** 解绑目标群；解绑不存在的绑定返回 `false`（归属群也可以被解绑）。 */
  public unbindGroup(activityId: string, groupId: string): boolean {
    const trimmed = groupId.trim();
    const bucket = this.boundGroups.get(activityId);
    if (!bucket?.delete(trimmed)) {
      return false;
    }
    if (bucket.size === 0) {
      this.boundGroups.delete(activityId);
    }
    const repository = this.groupRepository;
    if (repository) {
      this.queue?.enqueue("activity.group.remove", () =>
        repository.remove(activityId, trimmed),
      );
    }
    log.info("activity group unbound", { activityId, groupId: trimmed });
    return true;
  }

  /**
   * 活动的发布 / 广播目标群（排序，保证发送顺序稳定）。
   *
   * 没有任何绑定行时回落到归属群（`activities.group_id`）：老活动与极简单测的
   * `ActivityService` 都不需要显式绑定，发布行为与 §B2 一致。
   */
  public listBoundGroups(activityId: string): string[] {
    const activity = this.getActivity(activityId);
    const bound = [...(this.boundGroups.get(activityId) ?? [])].sort();
    if (bound.length > 0) {
      return bound;
    }
    return activity.groupId.length > 0 ? [activity.groupId] : [];
  }

  /** 是否显式绑定过该群（与用户确认的「绑定/解绑」语义一致）。 */
  public isGroupBound(activityId: string, groupId: string): boolean {
    return this.boundGroups.get(activityId)?.has(groupId.trim()) ?? false;
  }

  private addGroupBinding(activityId: string, groupId: string): void {
    const trimmed = groupId.trim();
    if (trimmed.length === 0) {
      return;
    }
    const bucket = this.boundGroups.get(activityId) ?? new Set<string>();
    bucket.add(trimmed);
    this.boundGroups.set(activityId, bucket);
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
    if (patch.mentionAll !== undefined) {
      activity.mentionAll = patch.mentionAll;
    }
    if (patch.notifyCreator !== undefined) {
      activity.notifyCreator = patch.notifyCreator;
    }
    if (patch.waitlistPromotion !== undefined) {
      activity.waitlistPromotion = patch.waitlistPromotion;
    }
    if ("closeAt" in patch) {
      if (patch.closeAt === undefined) {
        delete activity.closeAt;
      } else {
        activity.closeAt = patch.closeAt;
      }
    }
    this.activities.set(activityId, activity);
    this.persist(activity);
    this.persistSettings(activity);
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
    // 年级统一用两位（22）；为兼容历史配置，仍接受四位写法（2022）
    const yearLabel = `20${year}`;

    if (activity.denyYears.includes(year) || activity.denyYears.includes(yearLabel)) {
      throw new ActivityRuleError(`本活动不接受 ${year} 级报名`);
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

  /** 报名截止/状态判定：`closeAt` 到期即视为截止（懒校验，不依赖定时器）。 */
  public isRegistrationClosed(activity: Activity, now: Date = utcNow()): boolean {
    if (activity.status !== ActivityStatus.Open) {
      return true;
    }
    return activity.closeAt !== undefined && now.getTime() >= activity.closeAt.getTime();
  }

  /** 活动候补名单（按加入时间排序）。 */
  public listWaitlist(activityId: string): ActivityWaitlistEntry[] {
    return [...this.waitlist.values()]
      .filter((entry) => entry.activityId === activityId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((entry) => ({ ...entry }));
  }

  public findWaitlistEntry(
    activityId: string,
    userId: string,
  ): ActivityWaitlistEntry | undefined {
    const entry = this.waitlist.get(waitlistKey(activityId, userId));
    return entry ? { ...entry } : undefined;
  }

  /** 候补排位（1 起）；不在候补里返回 undefined。 */
  public waitlistPosition(activityId: string, userId: string): number | undefined {
    const index = this.listWaitlist(activityId).findIndex(
      (entry) => entry.userId === userId,
    );
    return index >= 0 ? index + 1 : undefined;
  }

  /**
   * 报名：名额没满 → 正式报名；满了 → 自动进候补（返回排位）。
   *
   * 与 `register()` 的区别：这里把「满员」当成正常分支而不是错误，
   * 并且统一做截止时间懒校验。
   *
   * §B4：registered 分支额外返回 `becameFull`（本次报名后**恰好满员**）与当前
   * `registered` 人数，调用方据此在所有绑定群广播一次「已满」卡。
   */
  public joinActivity(input: RegisterActivityInput):
    | {
        status: "registered";
        registration: ActivityRegistration;
        /** 本次报名后是否刚好满员（`已报名 === capacity`）。 */
        becameFull: boolean;
        /** 当前已报名人数（含本次）。 */
        registered: number;
      }
    | { status: "waitlisted"; position: number; entry: ActivityWaitlistEntry } {
    const activity = this.getActivity(input.activityId);
    if (this.isRegistrationClosed(activity)) {
      throw new ActivityRuleError(
        activity.status !== ActivityStatus.Open
          ? `活动未开放报名：${activity.title}`
          : `报名已截止：${activity.title}`,
      );
    }
    if (this.findRegistration(activity.activityId, input.userId)) {
      throw new ActivityRuleError("你已经报名过该活动了");
    }
    const existingWaitlist = this.findWaitlistEntry(activity.activityId, input.userId);
    if (existingWaitlist) {
      throw new ActivityRuleError(
        `你已经在候补名单里（第 ${this.waitlistPosition(activity.activityId, input.userId) ?? 0} 位）`,
      );
    }
    const current = this.listRegistrations(activity.activityId);
    // 冻结名额（手动模式下被取消、但还没被管理员释放的位置）同样算占用
    const occupied = current.length + activity.heldSlots;
    const full =
      activity.capacity !== undefined && occupied >= activity.capacity;
    if (full) {
      const entry: ActivityWaitlistEntry = {
        activityId: activity.activityId,
        userId: input.userId,
        displayName: input.displayName ?? "",
        note: input.note ?? "",
        createdAt: utcNow(),
      };
      this.waitlist.set(waitlistKey(entry.activityId, entry.userId), entry);
      const waitlistRepository = this.waitlistRepository;
      if (waitlistRepository) {
        this.queue?.enqueue("activity.waitlist.save", () =>
          waitlistRepository.save(entry),
        );
      }
      return {
        status: "waitlisted",
        position: this.waitlistPosition(entry.activityId, entry.userId) ?? 1,
        entry: { ...entry },
      };
    }
    const registration = this.register(input);
    const registered = this.listRegistrations(input.activityId).length;
    // 冻结名额也算占用，因此「恰好满员」用 occupied 判定：1/1 与 1/2（held=1）都算满
    const occupiedAfter = registered + activity.heldSlots;
    return {
      status: "registered",
      registration,
      registered,
      becameFull:
        activity.capacity !== undefined && occupiedAfter >= activity.capacity,
    };
  }

  /**
   * 取消报名；**递补方式由活动配置决定**：
   *
   * - `auto`（自动递补）：立刻把候补第一位转正；
   * - `manual`（手动释放名额，默认）：空位被**冻结**（`heldSlots + 1`），
   *   新人不能直接占用，等管理员调用 `releaseHeldSlot()` 释放。
   */
  public cancelRegistrationWithPromotion(
    registrationId: string,
    userId: string,
  ): {
    cancelled: ActivityRegistration;
    promoted?: ActivityWaitlistEntry;
    registration?: ActivityRegistration;
    position?: number;
    heldSlots: number;
  } {
    const cancelled = this.cancelRegistration(registrationId, userId);
    const activity = this.getActivity(cancelled.activityId);
    if (activity.waitlistPromotion === "auto") {
      const promoted = this.promoteNextWaitlist(cancelled.activityId);
      return promoted
        ? { cancelled, heldSlots: 0, ...promoted }
        : { cancelled, heldSlots: 0 };
    }
    const updated = this.setHeldSlots(cancelled.activityId, activity.heldSlots + 1);
    return { cancelled, heldSlots: updated.heldSlots };
  }

  /** 当前冻结（待释放）的名额数。 */
  public heldSlots(activityId: string): number {
    return this.getActivity(activityId).heldSlots;
  }

  /**
   * 管理员「释放名额」：解冻一个名额，并优先给候补第一位；没有候补就放回公开池。
   *
   * 返回 `promoted` 时表示候补者已转正（调用方应私信通知），否则名额已开放给先到先得。
   */
  public releaseHeldSlot(activityId: string):
    | {
        released: "promoted" | "opened";
        promoted?: ActivityWaitlistEntry;
        registration?: ActivityRegistration;
        heldSlots: number;
      }
    | undefined {
    const activity = this.getActivity(activityId);
    if (activity.heldSlots <= 0) {
      return undefined;
    }
    const updated = this.setHeldSlots(activityId, activity.heldSlots - 1);
    const promoted = this.promoteNextWaitlist(activityId);
    if (promoted) {
      return { released: "promoted", ...promoted, heldSlots: updated.heldSlots };
    }
    return { released: "opened", heldSlots: updated.heldSlots };
  }

  /** 写入冻结名额数（同时持久化到 activity_settings）。 */
  private setHeldSlots(activityId: string, value: number): Activity {
    const activity = this.getActivity(activityId);
    const heldSlots = Math.max(0, Math.trunc(value));
    const updated: Activity = { ...activity, heldSlots };
    this.activities.set(activityId, updated);
    this.persistSettings(updated);
    return cloneActivity(updated);
  }

  /**
   * 把候补第一位转成正式报名（有人取消时自动调用；管理端「递补下一位」也用它）。
   */
  public promoteNextWaitlist(activityId: string):
    | { promoted: ActivityWaitlistEntry; registration: ActivityRegistration }
    | undefined {
    const next = this.listWaitlist(activityId)[0];
    if (!next) {
      return undefined;
    }
    const activity = this.getActivity(activityId);
    this.waitlist.delete(waitlistKey(next.activityId, next.userId));
    const waitlistRepository = this.waitlistRepository;
    if (waitlistRepository) {
      this.queue?.enqueue("activity.waitlist.delete", () =>
        waitlistRepository.remove(next.activityId, next.userId),
      );
    }
    const registrationId = randomUUID();
    const registration: ActivityRegistration = {
      registrationId,
      activityId: next.activityId,
      groupId: activity.groupId,
      userId: next.userId,
      displayName: next.displayName,
      note: next.note,
      createdAt: next.createdAt,
    };
    this.registrations.set(registrationId, registration);
    if (this.repository) {
      this.queue?.enqueue("activity.registration.save", () =>
        this.repository!.saveRegistration(registration),
      );
    }
    return { promoted: { ...next }, registration: { ...registration } };
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
    this.persistSettings(activity);
  }

  /** 扩展设置（@全体 / 通知发起人 / 截止时间）写进 `activity_settings` KV 表。 */
  private persistSettings(activity: Activity): void {
    const repository = this.settingsRepository;
    if (!repository) {
      return;
    }
    const settings = settingsOf(activity);
    this.queue?.enqueue("activity.settings.mentionAll", () =>
      repository.save({
        activityId: activity.activityId,
        key: ACTIVITY_SETTING_KEYS.mentionAll,
        value: String(settings.mentionAll),
      }),
    );
    this.queue?.enqueue("activity.settings.notifyCreator", () =>
      repository.save({
        activityId: activity.activityId,
        key: ACTIVITY_SETTING_KEYS.notifyCreator,
        value: String(settings.notifyCreator),
      }),
    );
    this.queue?.enqueue("activity.settings.waitlistPromotion", () =>
      repository.save({
        activityId: activity.activityId,
        key: ACTIVITY_SETTING_KEYS.waitlistPromotion,
        value: settings.waitlistPromotion,
      }),
    );
    if (settings.closeAt !== undefined) {
      this.queue?.enqueue("activity.settings.closeAt", () =>
        repository.save({
          activityId: activity.activityId,
          key: ACTIVITY_SETTING_KEYS.closeAt,
          value: settings.closeAt!,
        }),
      );
    } else {
      this.queue?.enqueue("activity.settings.closeAt.clear", () =>
        repository.remove(activity.activityId, ACTIVITY_SETTING_KEYS.closeAt),
      );
    }
    if (settings.heldSlots > 0) {
      this.queue?.enqueue("activity.settings.heldSlots", () =>
        repository.save({
          activityId: activity.activityId,
          key: ACTIVITY_SETTING_KEYS.heldSlots,
          value: String(settings.heldSlots),
        }),
      );
    } else {
      this.queue?.enqueue("activity.settings.heldSlots.clear", () =>
        repository.remove(activity.activityId, ACTIVITY_SETTING_KEYS.heldSlots),
      );
    }
  }
}

/** 学号前两位 → 年级（`22`）；无效时抛业务错误。 */
