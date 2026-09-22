import type { Queryable } from "./queryable.js";
import { SCHEMA_SQL } from "./schema.js";

export async function migrate(db: Queryable): Promise<void> {
  await db.query(SCHEMA_SQL);
}
