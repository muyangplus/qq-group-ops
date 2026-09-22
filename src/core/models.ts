import type {
  AuditStatus,
  ModerationAction,
  RiskLevel,
} from "./enums.js";

export interface IncomingMessage {
  groupId: string;
  userId: string;
  messageId: string;
  content: string;
  receivedAt: Date;
}

export interface RuleMatch {
  ruleId: string;
  pattern: string;
  action: ModerationAction;
  reason: string;
  risk: RiskLevel;
}

export interface AuditRecord {
  recordId: string;
  groupId: string;
  actorId: string;
  action: string;
  status: AuditStatus;
  reason: string;
  targetUserId?: string;
  createdAt: Date;
}

export function utcNow(): Date {
  return new Date();
}

export function newIncomingMessage(
  groupId: string,
  userId: string,
  messageId: string,
  content: string,
): IncomingMessage {
  return {
    groupId,
    userId,
    messageId,
    content,
    receivedAt: utcNow(),
  };
}
