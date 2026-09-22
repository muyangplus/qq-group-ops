export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}
