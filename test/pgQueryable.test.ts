import { describe, expect, it } from "vitest";

import { PgQueryable, type PgPoolLike } from "../src/db/pgQueryable.js";

class FakePgPool implements PgPoolLike {
  public readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  private readonly rows: unknown[];

  public constructor(rows: unknown[] = []) {
    this.rows = rows;
  }

  public async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    this.calls.push({ text, values });
    return { rows: this.rows as Row[] };
  }
}

describe("PgQueryable", () => {
  it("delegates queries and maps rows", async () => {
    const pool = new FakePgPool([{ id: "1" }]);
    const db = new PgQueryable(pool);

    const result = await db.query<{ id: string }>("SELECT * FROM t", ["x"]);

    expect(result).toEqual({ rows: [{ id: "1" }] });
    expect(pool.calls).toEqual([{ text: "SELECT * FROM t", values: ["x"] }]);
  });
});
