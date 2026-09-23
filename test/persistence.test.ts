import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import type { QueryResult } from "../src/db/queryable.js";
import { connectPersistence, type PersistencePool } from "../src/persistence.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

class FakePool implements PersistencePool {
  public readonly inner = new FakeQueryable();
  public ended = false;
  public errorListeners = 0;

  public constructor(
    private readonly options: { failMigrate?: boolean; failEnd?: boolean } = {},
  ) {}

  public async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    if (this.options.failMigrate) {
      throw new Error("ECONNREFUSED 127.0.0.1:5432");
    }
    return this.inner.query<Row>(text, values);
  }

  public async end(): Promise<void> {
    if (this.options.failEnd) {
      throw new Error("pool already ended");
    }
    this.ended = true;
  }

  public on(): this {
    this.errorListeners += 1;
    return this;
  }
}

describe("connectPersistence", () => {
  it("uses in-memory mode only when explicitly requested", async () => {
    const persistence = await connectPersistence(
      loadSettings({ DATABASE_URL: "memory" }),
    );
    expect(persistence).toBeUndefined();
  });

  it("defaults to a SQLite file and migrates the schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-group-ops-persistence-"));
    const path = join(dir, "data", "bot.db");
    try {
      const persistence = await connectPersistence(
        loadSettings({ SQLITE_PATH: path }),
      );
      expect(persistence?.driver).toBe("sqlite");
      expect(existsSync(path)).toBe(true);
      await persistence?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps SQLite data across connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-group-ops-persistence-"));
    const path = join(dir, "bot.db");
    try {
      const first = await connectPersistence(loadSettings({ SQLITE_PATH: path }));
      await first?.identityBindings.bind("user", "u1", "10001");
      await first?.close();

      const second = await connectPersistence(loadSettings({ SQLITE_PATH: path }));
      await expect(second?.identityBindings.findAll()).resolves.toEqual([
        { kind: "user", officialId: "u1", externalId: "10001" },
      ]);
      await second?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates and exposes repositories for PostgreSQL", async () => {
    const pool = new FakePool();
    const urls: string[] = [];
    const persistence = await connectPersistence(
      loadSettings({ DATABASE_URL: "postgres://qqbot:secret@db:5432/ops" }),
      {
        createPool: (url) => {
          urls.push(url);
          return pool;
        },
      },
    );

    expect(urls).toEqual(["postgres://qqbot:secret@db:5432/ops"]);
    expect(persistence?.driver).toBe("postgres");
    expect(pool.ended).toBe(false);
    expect(pool.errorListeners).toBe(1);
    expect(pool.inner.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS identity_bindings",
    );

    await persistence?.close();
    expect(pool.ended).toBe(true);
  });

  it("fails fast when PostgreSQL is unreachable", async () => {
    const pool = new FakePool({ failMigrate: true });
    await expect(
      connectPersistence(loadSettings({ DATABASE_URL: "postgres://db/ops" }), {
        createPool: () => pool,
      }),
    ).rejects.toThrow(/无法连接或初始化 PostgreSQL/u);
    expect(pool.ended).toBe(true);
  });
});
