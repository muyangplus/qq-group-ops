import { randomUUID } from "node:crypto";

import {
  AuditStatus,
  JoinRequestStatus,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AuditRecord } from "../core/models.js";
import { utcNow } from "../core/models.js";
import type { JoinRequestRepository } from "../db/joinRequestRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import type { AuditLog } from "./audit.js";
import { AuditLogStore } from "./audit.js";

const log = getLogger("join-audit");

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
  private readonly repository: JoinRequestRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(
    private readonly auditLog: AuditLog = new AuditLogStore(),
    repository?: JoinRequestRepository,
    queue?: WriteQueue,
  ) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const requests = await this.repository.findAll();
    this.requests.clear();
    for (const request of requests) {
      this.requests.set(request.requestId, request);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
    await this.auditLog.flush?.();
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
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("join-request.submit", () => repository.upsert(request));
    }
    log.debug("submitted", { requestId, groupId, userId });
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

  /**
   * 删除早于 cutoff 且已审批的申请（内存 + 数据库），返回删除条数。
   * 待审批申请永不清理，避免丢失需要处理的请求。
   */
  public async pruneReviewedOlderThan(cutoff: Date): Promise<number> {
    let removed = 0;
    for (const [requestId, request] of this.requests) {
      if (
        request.status !== JoinRequestStatus.Pending &&
        request.createdAt < cutoff
      ) {
        this.requests.delete(requestId);
        removed += 1;
      }
    }
    if (removed > 0) {
      const repository = this.repository;
      if (repository) {
        this.queue?.enqueue("join-request.prune", () =>
          repository.deleteReviewedOlderThan(cutoff),
        );
      }
    }
    return removed;
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
    const repository = this.repository;
    if (repository) {
      const reviewedAt = updated.reviewedAt ?? utcNow();
      this.queue?.enqueue("join-request.review", () =>
        repository.updateStatus(
          requestId,
          status,
          reviewerId,
          reviewedAt,
          reason,
        ),
      );
    }
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
    log.info("reviewed", { requestId, status, reviewerId });
    return { ...updated };
  }
}
