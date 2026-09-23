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
  it("stays in memory mode when DATABASE_URL is not configured", async () => {
    const persistence = await connectPersistence(loadSettings({}));
    expect(persistence).toBeUndefined();
  });

  it("migrates and exposes the identity binding repository", async () => {
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
    expect(pool.ended).toBe(false);
    expect(pool.errorListeners).toBe(1);
    expect(pool.inner.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS identity_bindings",
    );
    expect(persistence?.identityBindings).toBeDefined();

    await persistence?.close();
    expect(pool.ended).toBe(true);
  });

  it("fails fast when the database is unreachable", async () => {
    const pool = new FakePool({ failMigrate: true });
    await expect(
      connectPersistence(loadSettings({ DATABASE_URL: "postgres://db/ops" }), {
        createPool: () => pool,
      }),
    ).rejects.toThrow(/无法连接或初始化 PostgreSQL/u);
    expect(pool.ended).toBe(true);
  });
});
