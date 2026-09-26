import type { BlacklistScope } from "./blacklistRepository.js";
import type { Queryable } from "./queryable.js";

/**
 * 处罚记录（`punishment_records`，§B7）。
 *
 * 一条记录代表「机器人对某人执行了一次处罚」，存下**实际动作**，因此审核员在私信卡片上
 * 可以直接调整处罚：
 * - 「解除处罚」按记录里的动作逐项撤销（解禁 / 解除拉黑；撤回与踢出无法撤销）；
 * - 「修改禁言时长」「踢出」「拉黑（本群 / 全局）」在记录上追加动作并写审计。
 */
export interface PunishmentActions {
  /** 是否撤回了消息（不可撤销，仅用于展示）。 */
  recalled: boolean;
  /** 是否禁言中。 */
  muted: boolean;
  /** 原禁言时长（秒）。 */
  muteDurationSeconds: number;
  /** 是否已移出群（不可撤销，仅用于展示）。 */
  kicked: boolean;
  /** `""` 未拉黑 / `group` 本群 / `global` 全局。 */
  blacklist: "" | BlacklistScope;
}

export type PunishmentStatus = "active" | "released";

export interface PunishmentRecord {
  /** 6 位随机短码，展示为 `#A1B2C3`。 */
  recordId: string;
  groupId: string;
  /** 被处罚人（group_member_openid）。 */
  userId: string;
  /** 执行者：`bot` / `bot:auto` / 审核员 userId。 */
  actorId: string;
  /** 来源：`keyword` / `manual` / `card`。 */
  source: string;
  /** 命中的规则说明（卡片上展示）。 */
  ruleReason: string;
  /** 触发处罚的消息 id（可空）。 */
  messageId: string;
  /**
   * 触发处罚的消息原文（§B7，已压成单行并截断）。
   *
   * 只有本群 `rawMessageRetentionDays > 0` 时才写入；`''` 表示未保留
   * （卡片上显示「（未保留原文）」），到期后由 `RetentionService` 清空。
   */
  messageExcerpt: string;
  actions: PunishmentActions;
  /** 各动作的执行结果（`recall+mute+warn`、`mute_failed` …）。 */
  detail: string;
  status: PunishmentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PunishmentRepository {
  findAll(): Promise<PunishmentRecord[]>;
  save(record: PunishmentRecord): Promise<void>;
  deleteOlderThan(cutoff: Date): Promise<void>;
}

interface PunishmentRow {
  record_id: string;
  group_id: string;
  user_id: string;
  actor_id: string;
  source: string;
  rule_reason: string;
  message_id: string;
  message_excerpt: string;
  actions: string;
  detail: string;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const SELECT_ALL_SQL = `
SELECT record_id, group_id, user_id, actor_id, source, rule_reason, message_id,
       message_excerpt, actions, detail, status, created_at, updated_at
FROM punishment_records
ORDER BY created_at ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO punishment_records (
  record_id, group_id, user_id, actor_id, source, rule_reason, message_id,
  message_excerpt, actions, detail, status, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (record_id) DO UPDATE SET
  message_excerpt = $8,
  actions = $9,
  detail = $10,
  status = $11,
  updated_at = $13
`.trim();

const DELETE_OLDER_THAN_SQL = `
DELETE FROM punishment_records
WHERE created_at < $1
`.trim();

export class SqlPunishmentRepository implements PunishmentRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<PunishmentRecord[]> {
    const result = await this.db.query<PunishmentRow>(SELECT_ALL_SQL);
    return result.rows.map(rowToRecord);
  }

  public async save(record: PunishmentRecord): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      record.recordId,
      record.groupId,
      record.userId,
      record.actorId,
      record.source,
      record.ruleReason,
      record.messageId,
      record.messageExcerpt,
      JSON.stringify(record.actions),
      record.detail,
      record.status,
      record.createdAt.toISOString(),
      record.updatedAt.toISOString(),
    ]);
  }

  public async deleteOlderThan(cutoff: Date): Promise<void> {
    await this.db.query(DELETE_OLDER_THAN_SQL, [cutoff.toISOString()]);
  }
}

function rowToRecord(row: PunishmentRow): PunishmentRecord {
  return {
    recordId: row.record_id,
    groupId: row.group_id,
    userId: row.user_id,
    actorId: row.actor_id,
    source: row.source,
    ruleReason: row.rule_reason,
    messageId: row.message_id,
    messageExcerpt: row.message_excerpt ?? "",
    actions: parseActions(row.actions),
    detail: row.detail,
    status: row.status as PunishmentStatus,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at
        : new Date(row.updated_at),
  };
}

/** 容错解析：老数据 / 手工改坏的行退化为「无动作」，不让启动失败。 */
export function parseActions(value: string): PunishmentActions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const source =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const blacklist =
    source.blacklist === "group" || source.blacklist === "global"
      ? source.blacklist
      : "";
  return {
    recalled: source.recalled === true,
    muted: source.muted === true,
    muteDurationSeconds:
      typeof source.muteDurationSeconds === "number" &&
      Number.isFinite(source.muteDurationSeconds)
        ? source.muteDurationSeconds
        : 0,
    kicked: source.kicked === true,
    blacklist,
  };
}
