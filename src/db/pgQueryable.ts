import type { Queryable, QueryResult } from "./queryable.js";

export interface PgPoolLike {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

export class PgQueryable implements Queryable {
  public constructor(private readonly pool: PgPoolLike) {}

  public async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const result = await this.pool.query<Row>(text, values);
    return { rows: result.rows };
  }
}
