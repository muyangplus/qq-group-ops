import { randomUUID } from "node:crypto";

import {
  AuditStatus,
  JoinRequestStatus,
} from "../core/enums.js";
import type { AuditRecord } from "../core/models.js";
import { utcNow } from "../core/models.js";
import type { AuditLog } from "./audit.js";
import { InMemoryAuditLog } from "./audit.js";

export interface JoinRequest {
  requestId: string;
  groupId: string;
  userId: string;
  reason: string;
  status: JoinRequestStatus;
  createdAt: Date;
  reviewedAt?: Date;
  reviewerId?: string;
}

export class JoinAuditService {
  private readonly requests = new Map<string, JoinRequest>();
  private readonly auditLog: AuditLog;

  public constructor(auditLog: AuditLog = new InMemoryAuditLog()) {
    this.auditLog = auditLog;
  }

  public submit(
    groupId: string,
    userId: string,
    reason = "",
    requestId: string = randomUUID(),
  ): JoinRequest {
    if (this.requests.has(requestId)) {
      throw new Error(`duplicate join request id: ${requestId}`);
    }
    const request: JoinRequest = {
      requestId,
      groupId,
      userId,
      reason,
      status: JoinRequestStatus.Pending,
      createdAt: utcNow(),
    };
    this.requests.set(requestId, request);
    return { ...request };
  }

  public get(requestId: string): JoinRequest {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`join request not found: ${requestId}`);
    }
    return { ...request };
  }

  public pending(groupId: string): JoinRequest[] {
    return [...this.requests.values()]
      .filter(
        (request) =>
          request.groupId === groupId && request.status === JoinRequestStatus.Pending,
      )
      .map((request) => ({ ...request }));
  }

  public approve(requestId: string, reviewerId: string): JoinRequest {
    return this.review(
      requestId,
      reviewerId,
      JoinRequestStatus.Approved,
      AuditStatus.Approved,
      "",
    );
  }

  public reject(requestId: string, reviewerId: string, reason = ""): JoinRequest {
    return this.review(
      requestId,
      reviewerId,
      JoinRequestStatus.Rejected,
      AuditStatus.Rejected,
      reason,
    );
  }

  private review(
    requestId: string,
    reviewerId: string,
    status: JoinRequestStatus,
    auditStatus: AuditStatus,
    reason: string,
  ): JoinRequest {
    const request = this.get(requestId);
    if (request.status !== JoinRequestStatus.Pending) {
      throw new Error(`join request already reviewed: ${requestId}`);
    }
    const updated: JoinRequest = {
      ...request,
      status,
      reviewerId,
      reviewedAt: utcNow(),
    };
    this.requests.set(requestId, updated);
    const record: AuditRecord = {
      recordId: randomUUID(),
      groupId: request.groupId,
      actorId: reviewerId,
      targetUserId: request.userId,
      action:
        status === JoinRequestStatus.Approved
          ? "approve_join_request"
          : "reject_join_request",
      status: auditStatus,
      reason,
      createdAt: utcNow(),
    };
    this.auditLog.append(record);
    return { ...updated };
  }
}
