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

export const PermissionLevel = {
  Guest: "guest",
  Member: "member",
  Moderator: "moderator",
  GroupAdmin: "group_admin",
  SuperAdmin: "super_admin",
} as const;
export type PermissionLevel = (typeof PermissionLevel)[keyof typeof PermissionLevel];

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
