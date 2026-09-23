import { newDb } from "pg-mem";

import { PgQueryable } from "../../src/db/pgQueryable.js";

/** 用 pg-mem（内存 PostgreSQL 实现）构造一个可执行真实 SQL 的 Queryable。 */
export function createPgMemQueryable(): PgQueryable {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  return new PgQueryable(
    pool as unknown as ConstructorParameters<typeof PgQueryable>[0],
  );
}
