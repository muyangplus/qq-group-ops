import type { AuditRecord } from "../core/models.js";
import type { AuditStatus } from "../core/enums.js";
import type { Queryable } from "./queryable.js";

export interface AuditRepository {
  append(record: AuditRecord): Promise<void>;
  findByGroup(groupId: string): Promise<AuditRecord[]>;
  findAll(): Promise<AuditRecord[]>;
}

interface AuditRow {
  record_id: string;
  group_id: string;
  actor_id: string;
  target_user_id: string | null;
  action: string;
  status: string;
  reason: string;
  created_at: string | Date;
}

const INSERT_SQL = `
INSERT INTO audit_records (
  record_id, group_id, actor_id, target_user_id,
  action, status, reason, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`.trim();

const SELECT_BY_GROUP_SQL = `
SELECT record_id, group_id, actor_id, target_user_id,
       action, status, reason, created_at
FROM audit_records
WHERE group_id = $1
ORDER BY created_at DESC
`.trim();

const SELECT_ALL_SQL = `
SELECT record_id, group_id, actor_id, target_user_id,
       action, status, reason, created_at
FROM audit_records
ORDER BY created_at ASC
`.trim();

export class PostgresAuditRepository implements AuditRepository {
  public constructor(private readonly db: Queryable) {}

  public async append(record: AuditRecord): Promise<void> {
    await this.db.query(INSERT_SQL, [
      record.recordId,
      record.groupId,
      record.actorId,
      record.targetUserId ?? null,
      record.action,
      record.status,
      record.reason,
      record.createdAt.toISOString(),
    ]);
  }

  public async findByGroup(groupId: string): Promise<AuditRecord[]> {
    const result = await this.db.query<AuditRow>(SELECT_BY_GROUP_SQL, [groupId]);
    return result.rows.map(rowToAuditRecord);
  }

  public async findAll(): Promise<AuditRecord[]> {
    const result = await this.db.query<AuditRow>(SELECT_ALL_SQL);
    return result.rows.map(rowToAuditRecord);
  }
}

function rowToAuditRecord(row: AuditRow): AuditRecord {
  return {
    recordId: row.record_id,
    groupId: row.group_id,
    actorId: row.actor_id,
    ...(row.target_user_id ? { targetUserId: row.target_user_id } : {}),
    action: row.action,
    status: row.status as AuditStatus,
    reason: row.reason,
    createdAt:
      row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}
