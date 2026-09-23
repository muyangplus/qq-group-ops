import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  SqliteQueryable,
  toSqliteValue,
  translateDialect,
  translatePlaceholders,
} from "../src/db/sqliteQueryable.js";

describe("translatePlaceholders", () => {
  it("converts $n placeholders to ? and remembers their order", () => {
    expect(translatePlaceholders("SELECT $1, $2 FROM t WHERE a = $1")).toEqual({
      sql: "SELECT ?, ? FROM t WHERE a = ?",
      positions: [0, 1, 0],
    });
  });

  it("leaves statements without placeholders untouched", () => {
    expect(translatePlaceholders("SELECT 1")).toEqual({
      sql: "SELECT 1",
      positions: [],
    });
  });
});

describe("translateDialect", () => {
  it("converts PostgreSQL schema types to SQLite", () => {
    expect(
      translateDialect(
        "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), enabled BOOLEAN",
      ),
    ).toBe("created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, enabled INTEGER");
  });

  it("strips explicit PostgreSQL type casts", () => {
    expect(translateDialect("WHEN $5::text IS NULL THEN 1")).toBe(
      "WHEN $5 IS NULL THEN 1",
    );
  });
});

describe("toSqliteValue", () => {
  it("converts non-SQLite values", () => {
    expect(toSqliteValue(true)).toBe(1);
    expect(toSqliteValue(false)).toBe(0);
    expect(toSqliteValue(undefined)).toBeNull();
    expect(toSqliteValue(null)).toBeNull();
    expect(toSqliteValue(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(toSqliteValue(42)).toBe(42);
    expect(toSqliteValue("x")).toBe("x");
  });
});

describe("SqliteQueryable", () => {
  function createQueryable(): SqliteQueryable {
    return new SqliteQueryable(new DatabaseSync(":memory:"));
  }

  it("runs DDL, writes and reads through the positional adapter", async () => {
    const db = createQueryable();
    await db.query("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, ok INTEGER)");
    await db.query(
      "INSERT INTO t (id, n, ok) VALUES ($1, $2, $3)",
      ["a", 1, true],
    );

    const result = await db.query<{ id: string; n: number; ok: number }>(
      "SELECT id, n, ok FROM t WHERE id = $1",
      ["a"],
    );

    expect(result.rows).toEqual([{ id: "a", n: 1, ok: 1 }]);
  });

  it("supports ON CONFLICT DO UPDATE", async () => {
    const db = createQueryable();
    await db.query("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
    await db.query("INSERT INTO t (id, n) VALUES ($1, $2)", ["a", 1]);
    await db.query(
      "INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n",
      ["a", 2],
    );

    const result = await db.query<{ n: number }>("SELECT n FROM t WHERE id = $1", [
      "a",
    ]);
    expect(result.rows).toEqual([{ n: 2 }]);
  });

  it("executes multi-statement migrations", async () => {
    const db = createQueryable();
    await db.query("CREATE TABLE a (x TEXT); CREATE TABLE b (y TEXT);");

    const result = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(result.rows.map((row) => row.name)).toEqual(["a", "b"]);
  });
});
