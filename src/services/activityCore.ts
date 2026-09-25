import { ActivityStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { ActivityWaitlistEntry } from "../db/activityWaitlistRepository.js";

/**
 * activity 的类型、常量与纯函数（从 activity.ts 拆出；主文件会原样再导出公开名字）。
 */


export type { ActivityWaitlistEntry };

export const log = getLogger("activity");

export const ACTIVITY_CODE_LENGTH = 6;
export const MAX_CODE_ATTEMPTS = 20;

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

/** 候补递补方式：`auto` = 有人取消就自动递补第一位；`manual` = 等管理员手动释放名额。 */
export type WaitlistPromotionMode = "auto" | "manual";

export interface Activity {
  activityId: string;
  /** 6 位随机短码（展示为 `#A7K2Q9`）。 */
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
  /** 开放报名时是否额外发一条 @全体成员 提醒（默认关）。 */
  mentionAll: boolean;
  /** 有人报名时是否私信通知活动发起人（默认关，避免群里刷屏）。 */
  notifyCreator: boolean;
  /** 候补递补方式：自动递补 / 管理员手动释放名额（**默认手动**）。 */
  waitlistPromotion: WaitlistPromotionMode;
  /**
   * 手动模式下「已取消但还没释放」的名额数（冻结名额）。
   *
   * 报名占用 = 已报名人数 + 冻结名额；管理员点「释放名额」才会把它转成
   * 「递补候补第一位」或「放回公开池」。自动递补模式恒为 0。
   */
  heldSlots: number;
  /** 报名截止时间；到期后**懒校验**拒绝报名（不再单独跑定时器）。 */
  closeAt?: Date;
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
  mentionAll?: boolean;
  notifyCreator?: boolean;
  waitlistPromotion?: WaitlistPromotionMode;
  closeAt?: Date;
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
  mentionAll?: boolean;
  notifyCreator?: boolean;
  waitlistPromotion?: WaitlistPromotionMode;
  closeAt?: Date | undefined;
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

export function applyDetails(activity: Activity, details: ActivityDetails): Activity {
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

export function cloneActivity(activity: Activity): Activity {
  return {
    ...activity,
    links: activity.links.map((link) => ({ ...link })),
    allowColleges: [...activity.allowColleges],
    denyColleges: [...activity.denyColleges],
    allowYears: [...activity.allowYears],
    denyYears: [...activity.denyYears],
    ...(activity.closeAt !== undefined ? { closeAt: new Date(activity.closeAt) } : {}),
  };
}

/** 候补名单的内存键：`activityId\0userId`。 */
export function waitlistKey(activityId: string, userId: string): string {
  return `${activityId}\u0000${userId}`;
}

/** 活动扩展设置（KV）的键名。 */
export const ACTIVITY_SETTING_KEYS = {
  mentionAll: "mentionAll",
  notifyCreator: "notifyCreator",
  closeAt: "closeAt",
  waitlistPromotion: "waitlistPromotion",
  heldSlots: "heldSlots",
} as const;

/** 把 KV 设置应用到活动对象上（缺省值：不 @全体、不通知、无截止、**手动释放名额**）。 */
export function applySettings(activity: Activity, bucket: ReadonlyMap<string, string>): Activity {
  const mentionAll = bucket.get(ACTIVITY_SETTING_KEYS.mentionAll);
  const notifyCreator = bucket.get(ACTIVITY_SETTING_KEYS.notifyCreator);
  const closeAt = bucket.get(ACTIVITY_SETTING_KEYS.closeAt);
  const promotion = bucket.get(ACTIVITY_SETTING_KEYS.waitlistPromotion);
  const heldSlots = Number.parseInt(bucket.get(ACTIVITY_SETTING_KEYS.heldSlots) ?? "", 10);
  const parsedCloseAt = closeAt ? new Date(closeAt) : undefined;
  return {
    ...activity,
    mentionAll: mentionAll === undefined ? activity.mentionAll : mentionAll === "true",
    notifyCreator:
      notifyCreator === undefined ? activity.notifyCreator : notifyCreator === "true",
    waitlistPromotion:
      promotion === "auto" || promotion === "manual"
        ? promotion
        : activity.waitlistPromotion,
    heldSlots: Number.isFinite(heldSlots) && heldSlots > 0 ? heldSlots : 0,
    ...(parsedCloseAt && !Number.isNaN(parsedCloseAt.getTime())
      ? { closeAt: parsedCloseAt }
      : activity.closeAt !== undefined
        ? { closeAt: activity.closeAt }
        : {}),
  };
}

/** 活动扩展设置的持久化载荷。 */
export function settingsOf(activity: Activity): {
  mentionAll: boolean;
  notifyCreator: boolean;
  waitlistPromotion: WaitlistPromotionMode;
  heldSlots: number;
  closeAt?: string;
} {
  return {
    mentionAll: activity.mentionAll,
    notifyCreator: activity.notifyCreator,
    waitlistPromotion: activity.waitlistPromotion,
    heldSlots: activity.heldSlots,
    ...(activity.closeAt !== undefined
      ? { closeAt: activity.closeAt.toISOString() }
      : {}),
  };
}

export function normalizeList(values: readonly string[]): string[] {
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
export function matchesCollege(list: readonly string[], college: string): boolean {
  return list.some(
    (value) =>
      value === college || college.includes(value) || value.includes(college),
  );
}
