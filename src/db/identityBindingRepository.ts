import type { Queryable } from "./queryable.js";

export type IdentityBindingKind = "user" | "group";

export interface IdentityBinding {
  kind: IdentityBindingKind;
  officialId: string;
  externalId: string;
  /** 首次绑定时间（老库 / 内存实现可能没有）。 */
  createdAt?: Date | undefined;
  /** 最近一次改绑时间（同上）。 */
  updatedAt?: Date | undefined;
}

export interface IdentityBindingRepository {
  bind(
    kind: IdentityBindingKind,
    officialId: string,
    externalId: string,
  ): Promise<void>;
  findAll(): Promise<IdentityBinding[]>;
}

export interface IdentityBindingRow {
  kind: string;
  official_id: string;
  external_id: string;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

const DELETE_SQL = `
DELETE FROM identity_bindings
WHERE kind = $1 AND (official_id = $2 OR external_id = $3)
`.trim();

const INSERT_SQL = `
INSERT INTO identity_bindings (kind, official_id, external_id, updated_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (kind, official_id) DO UPDATE
SET external_id = EXCLUDED.external_id,
    updated_at = NOW()
`.trim();

const SELECT_ALL_SQL = `
SELECT kind, official_id, external_id, created_at, updated_at
FROM identity_bindings
ORDER BY kind ASC, official_id ASC
`.trim();

/**
 * 绑定关系仓储（SQLite / PostgreSQL 通用）。
 *
 * 一个 officialId 在一个 kind 下只允许绑定一个 externalId，反之一一对应。
 * 重新绑定会先删除任一方向上的旧记录，再写入新记录。
 */
export class SqlIdentityBindingRepository
  implements IdentityBindingRepository
{
  public constructor(private readonly db: Queryable) {}

  public async bind(
    kind: IdentityBindingKind,
    officialId: string,
    externalId: string,
  ): Promise<void> {
    await this.db.query(DELETE_SQL, [kind, officialId, externalId]);
    await this.db.query(INSERT_SQL, [kind, officialId, externalId]);
  }

  public async findAll(): Promise<IdentityBinding[]> {
    const result = await this.db.query<IdentityBindingRow>(SELECT_ALL_SQL);
    return result.rows.map(rowToIdentityBinding);
  }
}

function rowToIdentityBinding(row: IdentityBindingRow): IdentityBinding {
  const createdAt = toDate(row.created_at);
  const updatedAt = toDate(row.updated_at);
  return {
    kind: parseKind(row.kind),
    officialId: row.official_id,
    externalId: row.external_id,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** 老库 / 假库里可能没有这两列；解析不出来就不带这个字段，而不是编一个时间。 */
function toDate(value: string | Date | null | undefined): Date | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseKind(value: string): IdentityBindingKind {
  if (value === "user" || value === "group") {
    return value;
  }
  throw new Error(`unknown identity binding kind: ${value}`);
}
