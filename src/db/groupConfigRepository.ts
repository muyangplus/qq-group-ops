import type { GroupConfigOverride } from "../services/groupConfig.js";
import type { Queryable } from "./queryable.js";

export interface GroupConfigRepository {
  loadOverride(groupId: string): Promise<GroupConfigOverride | null>;
  saveOverride(override: GroupConfigOverride): Promise<void>;
  deleteOverride(groupId: string): Promise<void>;
  loadKeywords(groupId: string): Promise<string[]>;
  replaceKeywords(groupId: string, keywords: readonly string[]): Promise<void>;
  findAll(): Promise<GroupConfigOverride[]>;
}

interface GroupConfigRow {
  group_id: string;
  enabled: boolean | number | null;
  join_audit_enabled: boolean | number | null;
  auto_approve_join: boolean | number | null;
  word_filter_enabled: boolean | number | null;
  export_enabled: boolean | number | null;
  raw_message_retention_days: number | null;
  mute_duration_seconds: number | null;
  warning_message: string | null;
}

const SELECT_SQL = `
SELECT group_id, enabled, join_audit_enabled, auto_approve_join,
       word_filter_enabled, export_enabled, raw_message_retention_days,
       mute_duration_seconds, warning_message
FROM group_configs
WHERE group_id = $1
`.trim();

const SELECT_ALL_SQL = `
SELECT group_id, enabled, join_audit_enabled, auto_approve_join,
       word_filter_enabled, export_enabled, raw_message_retention_days,
       mute_duration_seconds, warning_message
FROM group_configs
ORDER BY group_id ASC
`.trim();

const SELECT_ALL_KEYWORDS_SQL = `
SELECT group_id, keyword
FROM group_keywords
ORDER BY group_id ASC, keyword ASC
`.trim();

const UPSERT_SQL = `
INSERT INTO group_configs (
  group_id, enabled, join_audit_enabled, auto_approve_join,
  word_filter_enabled, export_enabled, raw_message_retention_days,
  mute_duration_seconds, warning_message, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
ON CONFLICT (group_id) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  join_audit_enabled = EXCLUDED.join_audit_enabled,
  auto_approve_join = EXCLUDED.auto_approve_join,
  word_filter_enabled = EXCLUDED.word_filter_enabled,
  export_enabled = EXCLUDED.export_enabled,
  raw_message_retention_days = EXCLUDED.raw_message_retention_days,
  mute_duration_seconds = EXCLUDED.mute_duration_seconds,
  warning_message = EXCLUDED.warning_message,
  updated_at = NOW()
`.trim();

const DELETE_SQL = "DELETE FROM group_configs WHERE group_id = $1";
const SELECT_KEYWORDS_SQL = `
SELECT keyword
FROM group_keywords
WHERE group_id = $1
ORDER BY keyword ASC
`.trim();
const DELETE_KEYWORDS_SQL = "DELETE FROM group_keywords WHERE group_id = $1";
const INSERT_KEYWORD_SQL = `
INSERT INTO group_keywords (group_id, keyword)
VALUES ($1, $2)
ON CONFLICT (group_id, keyword) DO NOTHING
`.trim();

export class SqlGroupConfigRepository implements GroupConfigRepository {
  public constructor(private readonly db: Queryable) {}

  public async loadOverride(groupId: string): Promise<GroupConfigOverride | null> {
    const result = await this.db.query<GroupConfigRow>(SELECT_SQL, [groupId]);
    const row = result.rows[0];
    return row ? rowToOverride(row) : null;
  }

  public async saveOverride(override: GroupConfigOverride): Promise<void> {
    await this.db.query(UPSERT_SQL, [
      override.groupId,
      override.enabled ?? null,
      override.joinAuditEnabled ?? null,
      override.autoApproveJoin ?? null,
      override.wordFilterEnabled ?? null,
      override.exportEnabled ?? null,
      override.rawMessageRetentionDays ?? null,
      override.muteDurationSeconds ?? null,
      override.warningMessage ?? null,
    ]);
  }

  public async deleteOverride(groupId: string): Promise<void> {
    await this.db.query(DELETE_SQL, [groupId]);
  }

  public async loadKeywords(groupId: string): Promise<string[]> {
    const result = await this.db.query<{ keyword: string }>(
      SELECT_KEYWORDS_SQL,
      [groupId],
    );
    return result.rows.map((row) => row.keyword);
  }

  public async replaceKeywords(
    groupId: string,
    keywords: readonly string[],
  ): Promise<void> {
    await this.db.query(DELETE_KEYWORDS_SQL, [groupId]);
    for (const keyword of keywords) {
      await this.db.query(INSERT_KEYWORD_SQL, [groupId, keyword]);
    }
  }

  public async findAll(): Promise<GroupConfigOverride[]> {
    const overrides = await this.db.query<GroupConfigRow>(SELECT_ALL_SQL);
    const keywords = await this.db.query<{ group_id: string; keyword: string }>(
      SELECT_ALL_KEYWORDS_SQL,
    );
    const keywordsByGroup = new Map<string, string[]>();
    for (const row of keywords.rows) {
      const list = keywordsByGroup.get(row.group_id) ?? [];
      list.push(row.keyword);
      keywordsByGroup.set(row.group_id, list);
    }
    return overrides.rows.map((row) => ({
      ...rowToOverride(row),
      ...(keywordsByGroup.has(row.group_id)
        ? { keywords: keywordsByGroup.get(row.group_id) ?? [] }
        : {}),
    }));
  }
}

function rowToOverride(row: GroupConfigRow): GroupConfigOverride {
  const enabled = optionalBoolean(row.enabled);
  const joinAuditEnabled = optionalBoolean(row.join_audit_enabled);
  const autoApproveJoin = optionalBoolean(row.auto_approve_join);
  const wordFilterEnabled = optionalBoolean(row.word_filter_enabled);
  const exportEnabled = optionalBoolean(row.export_enabled);
  return {
    groupId: row.group_id,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(joinAuditEnabled !== undefined ? { joinAuditEnabled } : {}),
    ...(autoApproveJoin !== undefined ? { autoApproveJoin } : {}),
    ...(wordFilterEnabled !== undefined ? { wordFilterEnabled } : {}),
    ...(exportEnabled !== undefined ? { exportEnabled } : {}),
    ...(row.raw_message_retention_days !== null
      ? { rawMessageRetentionDays: row.raw_message_retention_days }
      : {}),
    ...(row.mute_duration_seconds !== null
      ? { muteDurationSeconds: row.mute_duration_seconds }
      : {}),
    ...(row.warning_message !== null ? { warningMessage: row.warning_message } : {}),
  };
}

/** SQLite 没有布尔类型，读回来是 0/1；PostgreSQL 读回来是真正的 boolean。 */
function optionalBoolean(
  value: boolean | number | null,
): boolean | undefined {
  if (value === null) {
    return undefined;
  }
  return typeof value === "boolean" ? value : value !== 0;
}
