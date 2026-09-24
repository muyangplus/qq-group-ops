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

/** 待审批申请的默认有效期：7 天。 */
export const DEFAULT_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * 与官方列表对账时，申请至少存在这么久才允许判定为「官方已散失」。
 *
 * 官方列表可能有分页/滞后，刚创建不久的申请暂时不在列表里不代表已处理。
 */
export const DEFAULT_RECONCILE_MIN_AGE_MS = 60 * 60 * 1_000;
/** 自动过期时的操作人标识（写入审计，便于区分人工处理）。 */
export const EXPIRY_ACTOR_ID = "system:expired";

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
  /** 待审批申请的有效期（毫秒）；0 = 不自动过期。 */
  private pendingTtlMs = DEFAULT_PENDING_TTL_MS;

  public constructor(
    private readonly auditLog: AuditLog = new AuditLogStore(),
    repository?: JoinRequestRepository,
    queue?: WriteQueue,
  ) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  /** 设置待审批申请的有效期（毫秒）；0 表示不自动过期。 */
  public setPendingTtlMs(ttlMs: number): void {
    this.pendingTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  }

  public get pendingTtlMsValue(): number {
    return this.pendingTtlMs;
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

  /** 是否已经记录过该申请（用于事件重投时幂等处理）。 */
  public has(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  public pending(groupId: string): JoinRequest[] {
    // 查询即懒清理：过期的申请不再出现在队列、推送与统计里
    this.expireStalePending();
    return [...this.requests.values()]
      .filter(
        (request) =>
          request.groupId === groupId && request.status === JoinRequestStatus.Pending,
      )
      .map((request) => ({ ...request }));
  }

  /**
   * 把超过 TTL 的待审批申请标记为过期（`expired`），返回条数。
   *
   * 只改状态、不删数据：`/audit` 与 `/whois` 仍能查到；`/pending`、推送与统计自动不再包含它。
   */
  public expireStalePending(now: number = Date.now()): number {
    if (this.pendingTtlMs <= 0) {
      return 0;
    }
    return this.expirePending(
      (request) => now - request.createdAt.getTime() >= this.pendingTtlMs,
      "超过待审批有效期，自动标记过期",
    );
  }

  /**
   * 与官方待审批列表对账：官方已不再返回、且已存在超过 `minAgeMs` 的本地待审批申请标记为过期。
   *
   * `minAgeMs` 用于避免官方列表分页/滞后造成误判（刚提交的申请可能暂时不在列表里）。
   */
  public expireMissingFromRemote(
    groupId: string,
    remoteRequestIds: ReadonlySet<string>,
    options: { minAgeMs?: number; now?: number } = {},
  ): number {
    const minAgeMs = options.minAgeMs ?? DEFAULT_RECONCILE_MIN_AGE_MS;
    const now = options.now ?? Date.now();
    return this.expirePending(
      (request) =>
        request.groupId === groupId &&
        !remoteRequestIds.has(request.requestId) &&
        now - request.createdAt.getTime() >= minAgeMs,
      "官方待审批列表已不再包含该申请，自动标记过期",
    );
  }

  private expirePending(
    predicate: (request: JoinRequest) => boolean,
    reason: string,
  ): number {
    let changed = 0;
    for (const [requestId, request] of [...this.requests]) {
      if (request.status !== JoinRequestStatus.Pending) {
        continue;
      }
      if (!predicate(request)) {
        continue;
      }
      const updated: JoinRequest = {
        ...request,
        status: JoinRequestStatus.Expired,
        reviewerId: EXPIRY_ACTOR_ID,
        reviewedAt: utcNow(),
      };
      this.requests.set(requestId, updated);
      this.enqueueExpiry(updated, reason);
      changed += 1;
      log.info("join request expired", {
        requestId,
        groupId: request.groupId,
        reason,
      });
    }
    return changed;
  }

  /** 过期：写穿透 + 记一条 `expire_join_request` 审计，便于 /audit 与 /whois 追溯。 */
  private enqueueExpiry(updated: JoinRequest, reason: string): void {
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("join-request.expire", () =>
        repository.updateStatus(
          updated.requestId,
          updated.status,
          updated.reviewerId ?? EXPIRY_ACTOR_ID,
          updated.reviewedAt ?? utcNow(),
          reason,
        ),
      );
    }
    this.auditLog.append({
      recordId: randomUUID(),
      groupId: updated.groupId,
      actorId: EXPIRY_ACTOR_ID,
      targetUserId: updated.userId,
      action: "expire_join_request",
      status: AuditStatus.Expired,
      reason,
      createdAt: utcNow(),
    });
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
