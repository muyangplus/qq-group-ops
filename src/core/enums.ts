export const RiskLevel = {
  Low: "low",
  Medium: "medium",
  High: "high",
  Critical: "critical",
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const ModerationAction = {
  Allow: "allow",
  Warn: "warn",
  Review: "review",
  Recall: "recall",
  Mute: "mute",
  Kick: "kick",
} as const;
export type ModerationAction = (typeof ModerationAction)[keyof typeof ModerationAction];

export const AuditStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  AutoApproved: "auto_approved",
  AutoRejected: "auto_rejected",
  Executed: "executed",
  /** 入群申请超过有效期、或被官方列表对账判定散失后自动过期。 */
  Expired: "expired",
} as const;
export type AuditStatus = (typeof AuditStatus)[keyof typeof AuditStatus];

export const ActivityStatus = {
  Draft: "draft",
  Open: "open",
  Closed: "closed",
  Cancelled: "cancelled",
} as const;
export type ActivityStatus = (typeof ActivityStatus)[keyof typeof ActivityStatus];

export const JoinRequestStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  Expired: "expired",
} as const;
export type JoinRequestStatus = (typeof JoinRequestStatus)[keyof typeof JoinRequestStatus];

/**
 * 权限等级：**数值即等级**，并分成两段互不重叠的区间 —— 这是「全局 / 群内」区分的硬保障：
 *
 * - **群内档 `1..99`**（`GroupLevel`）：成员 10 / 审核员 20 / 群管理员 30 / 本群超管 40；
 * - **平台档 `100..9999`**（`PlatformLevel`，**起点 100**）：全局超管取高位 **1000**，
 *   中间（100…999）留给以后的平台角色（平台审计 110 / 平台运营 120 / 只读平台管理员 …）——
 *   全局超管是平台档里的**高位**而不是起点，这样新平台角色可以排在它下面。
 *
 * 于是：`meetsInGroup`（群内，走「本群 + 全局取最大」）天然容忍全局超管；
 * `meetsGlobal`（平台级）**永远不可能**被群内档位满足（40 < 100，差一个数量级），
 * 反之传错类型也会**编译不过**（两个档位是不同的类型）。
 */
export const PermissionLevel = {
  /** 拉黑档位（-10）：任何带门槛 >= Guest 的能力都过不了。 */
  Blacklisted: -10,
  /** 未绑定 / 陌生访客。 */
  Guest: 0,
  /** 群成员。 */
  Member: 10,
  /** 审核员：内容审核、处罚与申诉。 */
  Moderator: 20,
  /** 群管理员：入群审批、规则管理、导出。 */
  GroupAdmin: 30,
  /** **本群**超级管理员（群内档最高）。 */
  SuperAdmin: 40,
  /** **全局**超级管理员（平台档高位，不是起点）。 */
  GlobalSuperAdmin: 1000,
} as const;

/** 群内档位取值（1..99，含门槛用的 -10 / 0）。 */
export type GroupLevel = -10 | 0 | 10 | 20 | 30 | 40;

/** 平台档**起点**：平台角色一律 >= 100，与群内档（<= 40）相隔一个数量级。 */
export const PLATFORM_LEVEL_MIN = 100;

declare const platformLevelBrand: unique symbol;
/**
 * 平台档位取值（100..9999）。
 *
 * 用 branded number 而不是字面量联合：平台档是一个**区间**（以后加 110 / 120 … 不用改类型），
 * 同时保证 `meetsInGroup(user, group, 1000)` 这类笔误**编译不过**。
 */
export type PlatformLevel = number & { readonly [platformLevelBrand]: "platform" };

/** 平台档常量（新增平台角色时在这里加一项，并给它一个 100..999 之外的合适值）。 */
export const PlatformLevel = {
  GlobalSuperAdmin: 1000 as PlatformLevel,
} as const;
/**
 * 权限等级的**类型**直接就是数值：留间隙、可插档（见上面的常量表）。
 *
 * 刻意不做成字面量联合：数值档位本身就是开放的（以后可能加 15 / 35），
 * 用 `number` 更贴合「可扩展」；取值一律用 `PermissionLevel.Xxx` 常量。
 */
export type PermissionLevel = number;

/** 等级的中文名（展示用；新增档位时在这里补一行即可）。 */
export function describeLevel(level: PermissionLevel): string {
  switch (level) {
    case PermissionLevel.Blacklisted:
      return "拉黑";
    case PermissionLevel.Guest:
      return "未绑定";
    case PermissionLevel.Member:
      return "群成员";
    case PermissionLevel.Moderator:
      return "审核员";
    case PermissionLevel.GroupAdmin:
      return "群管理员";
    case PermissionLevel.SuperAdmin:
      return "超级管理员";
    case PermissionLevel.GlobalSuperAdmin:
      return "全局超级管理员";
    default:
      return `等级 ${level as number}`;
  }
}

/** 关键词命中后的处罚动作。 */
export const KeywordPunish = {
  None: "none",
  /** 禁言 muteDurationSeconds 秒。 */
  Mute: "mute",
  /** 移出群。 */
  Kick: "kick",
  /** 移出群并加入黑名单（官方一次调用完成，需白名单）。 */
  KickBlacklist: "kick_blacklist",
} as const;
export type KeywordPunish = (typeof KeywordPunish)[keyof typeof KeywordPunish];

/** 入群申请推送的投递状态。 */
export const NotificationDeliveryStatus = {
  Sent: "sent",
  Failed: "failed",
} as const;
export type NotificationDeliveryStatus =
  (typeof NotificationDeliveryStatus)[keyof typeof NotificationDeliveryStatus];

/** 入群申请的处理方式。 */
export const JoinDecisionMode = {
  /** 全部人工审核（默认）。 */
  Manual: "manual",
  /** 自动通过（忽略规则）。 */
  AutoApprove: "auto_approve",
  /** 命中规则 → 通过；未命中 → 人工。 */
  ApproveOnMatch: "approve_on_match",
  /** 命中规则 → 拒绝；未命中 → 人工。 */
  RejectOnMatch: "reject_on_match",
  /** 未命中规则 → 拒绝；命中 → 人工（“必须回答正确”）。 */
  RejectOnMismatch: "reject_on_mismatch",
} as const;
export type JoinDecisionMode =
  (typeof JoinDecisionMode)[keyof typeof JoinDecisionMode];
