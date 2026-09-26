import type { Queryable, QueryResult } from "../../src/db/queryable.js";

export class FakeQueryable implements Queryable {
  public readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  /** 命中时抛错（测试迁移等容错分支）；返回 `undefined` 表示这条正常执行。 */
  public failWith: ((text: string) => Error | undefined) | undefined;
  private readonly responses: unknown[][];

  public constructor(responses: unknown[][] = []) {
    this.responses = [...responses];
  }

  public async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    const failure = this.failWith?.(text);
    if (failure) {
      throw failure;
    }
    const rows = this.responses.shift() ?? [];
    return { rows: rows as Row[] };
  }
}
