import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const SQLITE_MEMORY_PATH = ":memory:";

/**
 * 打开 SQLite 数据库并设置常用 PRAGMA。
 *
 * `node:sqlite` 是 Node.js 24+ 的内置模块，这里使用动态导入，
 * 以便在更早的 Node.js 上只配置 PostgreSQL / 内存模式时仍能启动，
 * 并给出可操作的错误提示。
 */
export async function openSqliteDatabase(path: string): Promise<DatabaseSync> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    throw new Error(
      "SQLite 默认数据库需要 Node.js 24+（内置 node:sqlite）。" +
        "请升级 Node.js，或将 DATABASE_URL 设为 PostgreSQL 连接串 / memory。",
      { cause: error },
    );
  }

  if (path !== SQLITE_MEMORY_PATH) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== SQLITE_MEMORY_PATH) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}
