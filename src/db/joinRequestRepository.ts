import { JoinRequestStatus } from "../core/enums.js";
import type { JoinRequest } from "../services/joinAudit.js";
import type { Queryable } from "./queryable.js";

export interface JoinRequestRepository {
  upsert(request: JoinRequest): Promise<void>;
  findPending(groupId: string): Promise<JoinRequest[]>;
  findById(requestId: string): Promise<JoinRequest | null>;
  findAll(): Promise<JoinRequest[]>;
  /** 删除早于 cutoff 且已审批（非 pending）的申请，用于数据保留策略。 */
  deleteReviewedOlderThan(cutoff: Date): Promise<void>;
  updateStatus(
    requestId: string,
    status: JoinRequestStatus,
    reviewerId: string,
    reviewedAt: Date,
    reason?: string,
  ): Promise<void>;
}

interface JoinRequestRow {
  request_id: string;
  group_id: string;
  user_id: string;
  reason: string;
  status: string;
  created_at: string | Date;
  reviewed_at: string | Date | null;
  reviewer_id: string | null;
}

const UPSERT_SQL = `
INSERT INTO join_requests (
  request_id, group_id, user_id, reason, status, created_at
) VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (request_id) DO NOTHING
`.trim();

const SELECT_PENDING_SQL = `
SELECT request_id, group_id, user_id, reason, status,
       created_at, reviewed_at, reviewer_id
FROM join_requests
WHERE group_id = $1 AND status = $2
ORDER BY created_at ASC
`.trim();

const SELECT_BY_ID_SQL = `
SELECT request_id, group_id, user_id, reason, status,
       created_at, reviewed_at, reviewer_id
FROM join_requests
WHERE request_id = $1
`.trim();

const SELECT_ALL_SQL = `
SELECT request_id, group_id, user_id, reason, status,
       created_at, reviewed_at, reviewer_id
FROM join_requests
ORDER BY created_at ASC
`.trim();

const DELETE_REVIEWED_OLDER_THAN_SQL = `
DELETE FROM join_requests
WHERE status <> $1 AND created_at < $2
`.trim();

const UPDATE_STATUS_SQL = `
UPDATE join_requests
SET status = $2,
    reviewer_id = $3,
    reviewed_at = $4,
    reason = CASE
      WHEN $5 IS NULL OR $5 = '' THEN reason
      ELSE $5
    END
WHERE request_id = $1
`.trim();

export class SqlJoinRequestRepository implements JoinRequestRepository {
  public constructor(private readonly db: Queryable) {}

  public async upsert(request: JoinRequest): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      request.requestId,
      request.groupId,
      request.userId,
      request.reason,
      request.status,
      request.createdAt.toISOString(),
    ]);
  }

  public async findPending(groupId: string): Promise<JoinRequest[]> {
    const result = await this.db.query<JoinRequestRow>(SELECT_PENDING_SQL, [
      groupId,
      "pending",
    ]);
    return result.rows.map(rowToJoinRequest);
  }

  public async findById(requestId: string): Promise<JoinRequest | null> {
    const result = await this.db.query<JoinRequestRow>(SELECT_BY_ID_SQL, [requestId]);
    const row = result.rows[0];
    return row ? rowToJoinRequest(row) : null;
  }

  public async findAll(): Promise<JoinRequest[]> {
    const result = await this.db.query<JoinRequestRow>(SELECT_ALL_SQL);
    return result.rows.map(rowToJoinRequest);
  }

  public async deleteReviewedOlderThan(cutoff: Date): Promise<void> {
    await this.db.query(DELETE_REVIEWED_OLDER_THAN_SQL, [
      JoinRequestStatus.Pending,
      cutoff.toISOString(),
    ]);
  }

  public async updateStatus(
    requestId: string,
    status: JoinRequestStatus,
    reviewerId: string,
    reviewedAt: Date,
    reason?: string,
  ): Promise<void> {
    await this.db.query(UPDATE_STATUS_SQL, [
      requestId,
      status,
      reviewerId,
      reviewedAt.toISOString(),
      reason ?? null,
    ]);
  }
}

function rowToJoinRequest(row: JoinRequestRow): JoinRequest {
  return {
    requestId: row.request_id,
    groupId: row.group_id,
    userId: row.user_id,
    reason: row.reason,
    status: row.status as JoinRequestStatus,
    createdAt:
      row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    ...(row.reviewed_at
      ? {
          reviewedAt:
            row.reviewed_at instanceof Date
              ? row.reviewed_at
              : new Date(row.reviewed_at),
        }
      : {}),
    ...(row.reviewer_id ? { reviewerId: row.reviewer_id } : {}),
  };
}
