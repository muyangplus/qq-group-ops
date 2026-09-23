import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Queryable, QueryResult } from "./queryable.js";

const READ_STATEMENT = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/iu;
const PLACEHOLDER = /\$(\d+)/gu;

export interface TranslatedPlaceholders {
  sql: string;
  /** 替换后第 i 个 `?` 对应的原始 values 下标。 */
  positions: number[];
}

/**
 * 把 PostgreSQL 风格的 `$1` 占位符转换为 SQLite 的 `?`。
 * 同一个 `$n` 可以出现多次，参数会按出现顺序展开。
 */
export function translatePlaceholders(text: string): TranslatedPlaceholders {
  const positions: number[] = [];
  const sql = text.replace(PLACEHOLDER, (_match, digits: string) => {
    positions.push(Number.parseInt(digits, 10) - 1);
    return "?";
  });
  return { sql, positions };
}

/**
 * 把 PostgreSQL 方言片段转换为 SQLite 可执行的形式。
 *
 * 只覆盖本项目 schema 与查询实际用到的差异：
 * `TIMESTAMPTZ`、`BOOLEAN`、`NOW()` 以及 `::type` 显式类型转换。
 */
export function translateDialect(text: string): string {
  return text
    .replace(/\bNOW\(\)/giu, "CURRENT_TIMESTAMP")
    .replace(/\bTIMESTAMPTZ\b/giu, "TEXT")
    .replace(/\bBOOLEAN\b/giu, "INTEGER")
    .replace(/::\s*[A-Za-z_][A-Za-z0-9_]*/gu, "");
}

/** SQLite 只接受 null / number / bigint / string / Uint8Array。 */
export function toSqliteValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return String(value);
}

export function hasMultipleStatements(sql: string): boolean {
  return sql.trim().replace(/;\s*$/u, "").includes(";");
}

/**
 * 基于 `node:sqlite` 的 Queryable 适配器。
 *
 * 仓储层使用 PostgreSQL 风格的 SQL（`$1` 占位符），由本适配器负责方言转换，
 * 因此同一个仓储实现可以同时跑在 SQLite 和 PostgreSQL 上。
 * `node:sqlite` 是同步 API，这里包一层 Promise 以匹配 `Queryable` 接口。
 */
export class SqliteQueryable implements Queryable {
  public constructor(private readonly db: DatabaseSync) {}

  public async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const translated = translatePlaceholders(translateDialect(text));
    const sql = translated.sql;
    const params = translated.positions.map((index) =>
      toSqliteValue(values?.[index]),
    );

    if (params.length === 0 && hasMultipleStatements(sql)) {
      this.db.exec(sql);
      return { rows: [] };
    }

    const statement = this.db.prepare(sql);
    if (READ_STATEMENT.test(sql)) {
      return { rows: statement.all(...params) as Row[] };
    }
    statement.run(...params);
    return { rows: [] };
  }
}
