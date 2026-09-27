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
 * - **群内档 `110..140`**：群成员 110 / 审核员 120 / 群管理员 130 / 本群超管 140；
 * - **平台档 = 群内档 + 100**：平台用户 210 / 全局审核员 220 / 全局管理员 230 / 全局超管 240；
 * - 最低档用负值、不与群内档连号：拉黑 -1 / 未绑定 0（只作门槛选项）。
 *
 * 跨轴折算只有一条公式（`PLATFORM_OFFSET = 100`）：
 *
 * ```
 * 群内权限 = max(群内档, 平台档 - 100)
 * 平台权限 = 平台档 >= 门槛（200..299）      ← 不看折算后的值
 * ```
 *
 * 于是「全局审核员 220 + 群内管理员 130」在群内 = max(130, 120) = 130，**不会压过**
 * 本群超管 140；而平台级能力只有平台档能过（本群超管 140 < 200）。
 */
export const PermissionLevel = {
  /** 拉黑档位（-1）：比未绑定还低一档，任何带门槛 >= Guest 的能力都过不了。 */
  Blacklisted: -1,
  /** 未绑定 / 陌生访客。 */
  Guest: 0,
  /** 群成员（群内档起点）。 */
  Member: 110,
  /** 审核员：内容审核、处罚与申诉。 */
  Moderator: 120,
  /** 群管理员：入群审批、规则管理、导出。 */
  GroupAdmin: 130,
  /** **本群**超级管理员（群内档最高）。 */
  SuperAdmin: 140,
  /** 平台绑定用户：有平台身份但无平台角色（平台档基底）。 */
  PlatformUser: 210,
  /** 全局审核员。 */
  GlobalModerator: 220,
  /** 全局管理员。 */
  GlobalGroupAdmin: 230,
  /** **全局**超级管理员（平台档最高）。 */
  GlobalSuperAdmin: 240,
} as const;

/** 平台档相对群内档的固定偏移：折算时 `平台档 - PLATFORM_OFFSET` 即对应群内档。 */
export const PLATFORM_OFFSET = 100;

/** 平台档起点：平台角色一律 >= 200，与群内档（<= 140）分开。 */
export const PLATFORM_LEVEL_MIN = 200;

/** 群内档位取值（含门槛用的负值 -1 / 0）。 */
export type GroupLevel = -1 | 0 | 110 | 120 | 130 | 140;

declare const platformLevelBrand: unique symbol;
/**
 * 平台档位取值（200..299）。
 *
 * 用 branded number：平台档是一个**区间**（以后加 215 平台只读、250 … 不用改类型），
 * 同时保证 `meetsInGroup(user, group, 240)` 这类笔误**编译不过**。
 */
export type PlatformLevel = number & { readonly [platformLevelBrand]: "platform" };

/** 平台档常量（新增平台角色时在这里加一项）。 */
export const PlatformLevel = {
  PlatformUser: 210 as PlatformLevel,
  GlobalModerator: 220 as PlatformLevel,
  GlobalGroupAdmin: 230 as PlatformLevel,
  GlobalSuperAdmin: 240 as PlatformLevel,
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
    case PermissionLevel.PlatformUser:
      return "平台用户";
    case PermissionLevel.GlobalModerator:
      return "全局审核员";
    case PermissionLevel.GlobalGroupAdmin:
      return "全局管理员";
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
