import type { Queryable } from "./queryable.js";

/**
 * 申诉记录（`appeal_records`，§B8）。
 *
 * 流程：当事人用 `/appeal #处罚短码 [理由]`（或点警告卡片上的「申诉」按钮）提交 →
 * 机器人私信推送给订阅了「处罚通知」的审核员及以上成员 → 审核员在卡片上直接调整处罚
 * （解除 / 改禁言时长 / 踢出 / 拉黑本群或全局）或驳回申诉。
 *
 * 同一条处罚的**同一当事人**只保留一条待处理申诉：重复提交会更新理由而不是刷屏。
 */
export type AppealStatus = "pending" | "accepted" | "rejected";

export interface AppealRecord {
  /** 6 位随机短码，展示为 `#A1B2C3`。 */
  appealId: string;
  /** 关联的处罚记录短码。 */
  punishmentId: string;
  groupId: string;
  /** 申诉人（被处罚人）。 */
  userId: string;
  reason: string;
  status: AppealStatus;
  /** 处理人 userId；未处理为空串。 */
  reviewerId: string;
  /** 处理备注 / 处理动作摘要。 */
  note: string;
  createdAt: Date;
  reviewedAt?: Date | undefined;
}

export interface AppealRepository {
  findAll(): Promise<AppealRecord[]>;
  save(record: AppealRecord): Promise<void>;
  deleteOlderThan(cutoff: Date): Promise<void>;
}

interface AppealRow {
  appeal_id: string;
  punishment_id: string;
  group_id: string;
  user_id: string;
  reason: string;
  status: string;
  reviewer_id: string;
  note: string;
  created_at: string | Date;
  reviewed_at: string | Date | null;
}

const SELECT_ALL_SQL = `
SELECT appeal_id, punishment_id, group_id, user_id, reason, status,
       reviewer_id, note, created_at, reviewed_at
FROM appeal_records
ORDER BY created_at ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO appeal_records (
  appeal_id, punishment_id, group_id, user_id, reason, status,
  reviewer_id, note, created_at, reviewed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (appeal_id) DO UPDATE SET
  reason = $5,
  status = $6,
  reviewer_id = $7,
  note = $8,
  reviewed_at = $10
`.trim();

const DELETE_OLDER_THAN_SQL = `
DELETE FROM appeal_records
WHERE created_at < $1
`.trim();

export class SqlAppealRepository implements AppealRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<AppealRecord[]> {
    const result = await this.db.query<AppealRow>(SELECT_ALL_SQL);
    return result.rows.map(rowToRecord);
  }

  public async save(record: AppealRecord): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      record.appealId,
      record.punishmentId,
      record.groupId,
      record.userId,
      record.reason,
      record.status,
      record.reviewerId,
      record.note,
      record.createdAt.toISOString(),
      record.reviewedAt ? record.reviewedAt.toISOString() : null,
    ]);
  }

  public async deleteOlderThan(cutoff: Date): Promise<void> {
    await this.db.query(DELETE_OLDER_THAN_SQL, [cutoff.toISOString()]);
  }
}

function rowToRecord(row: AppealRow): AppealRecord {
  return {
    appealId: row.appeal_id,
    punishmentId: row.punishment_id,
    groupId: row.group_id,
    userId: row.user_id,
    reason: row.reason,
    status: row.status as AppealStatus,
    reviewerId: row.reviewer_id,
    note: row.note,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
    ...(row.reviewed_at
      ? {
          reviewedAt:
            row.reviewed_at instanceof Date
              ? row.reviewed_at
              : new Date(row.reviewed_at),
        }
      : {}),
  };
}
