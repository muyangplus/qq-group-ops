import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate } from "../../src/db/migrate.js";
import type { Queryable } from "../../src/db/queryable.js";
import { openSqliteDatabase } from "../../src/db/sqliteDatabase.js";
import { SqliteQueryable } from "../../src/db/sqliteQueryable.js";
import { createPgMemQueryable } from "./pgMem.js";

export interface TestDatabase {
  driver: string;
  readonly queryable: Queryable;
  /** 模拟进程重启：关闭并重新打开底层连接（pg-mem 复用同一实例）。 */
  restart(): Promise<Queryable>;
  cleanup(): Promise<void>;
}

export async function createSqliteTestDatabase(): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), "qq-group-ops-test-"));
  const path = join(dir, "test.db");
  let db = await openSqliteDatabase(path);
  let queryable: Queryable = new SqliteQueryable(db);
  await migrate(queryable);

  return {
    driver: "sqlite",
    get queryable(): Queryable {
      return queryable;
    },
    async restart(): Promise<Queryable> {
      db.close();
      db = await openSqliteDatabase(path);
      queryable = new SqliteQueryable(db);
      return queryable;
    },
    async cleanup(): Promise<void> {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createPgMemTestDatabase(): Promise<TestDatabase> {
  const queryable = createPgMemQueryable();
  await migrate(queryable);
  return {
    driver: "pg-mem",
    queryable,
    async restart(): Promise<Queryable> {
      return queryable;
    },
    async cleanup(): Promise<void> {
      return undefined;
    },
  };
}

export const TEST_DATABASES: ReadonlyArray<{
  name: string;
  create: () => Promise<TestDatabase>;
}> = [
  { name: "sqlite", create: createSqliteTestDatabase },
  { name: "postgres (pg-mem)", create: createPgMemTestDatabase },
];
