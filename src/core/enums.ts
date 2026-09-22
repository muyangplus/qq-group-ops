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
