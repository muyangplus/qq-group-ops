import type { Queryable, QueryResult } from "../../src/db/queryable.js";

export class FakeQueryable implements Queryable {
  public readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  private readonly responses: unknown[][];

  public constructor(responses: unknown[][] = []) {
    this.responses = [...responses];
  }

  public async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    const rows = this.responses.shift() ?? [];
    return { rows: rows as Row[] };
  }
}
