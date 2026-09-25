import type { Queryable } from "./queryable.js";

/**
 * 随机短码 → 内部 id 的映射表。
 *
 * - `code` 是 6 位随机短码（数字 + 大写字母，唯一主键），展示时加 `#` 前缀（如 `#M7K2Q9`）；
 * - `(kind, target_id)` 唯一，保证同一个用户/群/申请只会有一个短码；
 * - 不使用自增 ID：短码随机生成、不可枚举，避免被猜到 id 后越权审核。
 */
export interface ShortCodeEntry {
  code: string;
  kind: string;
  /** 内部 id：userId / group_openid / join_request_id。 */
  targetId: string;
  createdAt: Date;
}

export interface ShortCodeRepository {
  findAll(): Promise<ShortCodeEntry[]>;
  /** 幂等写入：`code` 或 `(kind, target_id)` 冲突时忽略。 */
  save(entry: ShortCodeEntry): Promise<void>;
  /**
   * 迁移用：把 `oldCode` 那一行改成 `entry` 的短码（`(kind, target_id)` 不变）。
   * 用于把历史上含小写字母的短码重生成成「数字 + 大写字母」。
   */
  replaceCode(oldCode: string, entry: ShortCodeEntry): Promise<void>;
}

interface ShortCodeRow {
  code: string;
  kind: string;
  target_id: string;
  created_at: string | Date;
}

const SELECT_ALL_SQL = `
SELECT code, kind, target_id, created_at
FROM short_codes
ORDER BY created_at ASC
`.trim();

const INSERT_SQL = `
INSERT INTO short_codes (code, kind, target_id, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING
`.trim();

const REPLACE_CODE_SQL = "UPDATE short_codes SET code = $2 WHERE code = $1";

export class SqlShortCodeRepository implements ShortCodeRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<ShortCodeEntry[]> {
    const result = await this.db.query<ShortCodeRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      code: row.code,
      kind: row.kind,
      targetId: row.target_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    }));
  }

  public async save(entry: ShortCodeEntry): Promise<void> {
    await this.db.query(INSERT_SQL, [
      entry.code,
      entry.kind,
      entry.targetId,
      entry.createdAt.toISOString(),
    ]);
  }

  public async replaceCode(oldCode: string, entry: ShortCodeEntry): Promise<void> {
    await this.db.query(REPLACE_CODE_SQL, [oldCode, entry.code]);
  }
}
