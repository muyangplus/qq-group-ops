import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getLogger } from "../core/logger.js";

const log = getLogger("db-backup");

export interface BackupResult {
  /** 是否真的做了备份（PostgreSQL / 内存模式为 `false`，见 `skipped`）。 */
  ok: boolean;
  /** 没做备份时说明原因（可以直接展示）。 */
  skipped?: string;
  /** 备份文件路径（`ok=true` 时才有）。 */
  path?: string;
  detail: string;
}

/** 备份文件名：`{原名称}_YYYYMMDD_HHMMSS{原扩展名}`。 */
export function backupNameFor(sourcePath: string, now: Date): string {
  const ext = extname(sourcePath);
  const stem = basename(sourcePath, ext);
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stem}_${stamp}${ext}`;
}

/**
 * 备份 SQLite 库：把 `<path>` 复制成同目录下的 `{原名}_YYYYMMDD_HHMMSS.db`。
 *
 * 时间戳用**服务器本地时间**（和日志 / 卡片时间同一口径，方便对照）。
 * WAL 模式下只拷 `.db` 可能丢掉还没落盘的提交，所以连 `-wal` / `-shm` 一起拷
 * （同名后缀，SQLite 认这个配对）。
 */
export function backupSqliteDatabase(
  sourcePath: string,
  now: Date = new Date(),
): BackupResult {
  if (!existsSync(sourcePath)) {
    return { ok: false, detail: `数据库文件不存在：${sourcePath}` };
  }
  try {
    const target = join(dirname(sourcePath), backupNameFor(sourcePath, now));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(sourcePath, target);
    // WAL 日志也要一起带走，否则备份可能落后于最后一次提交
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${sourcePath}${suffix}`)) {
        cpSync(`${sourcePath}${suffix}`, `${target}${suffix}`);
      }
    }
    log.info("sqlite database backed up", { sourcePath, target });
    return { ok: true, path: target, detail: `已备份到 ${target}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("sqlite backup failed", { sourcePath, error: detail });
    return { ok: false, detail };
  }
}

/** 按数据库目标备份：SQLite 才做，PostgreSQL / 内存模式如实说明。 */
export function backupDatabase(target: {
  driver: "sqlite" | "postgres" | "memory";
  path?: string | undefined;
}): BackupResult {
  if (target.driver === "postgres") {
    return {
      ok: false,
      skipped: "PostgreSQL 不做文件备份，迁移前请自行 pg_dump",
      detail: "PostgreSQL 未自动备份",
    };
  }
  if (target.driver === "memory" || !target.path) {
    return {
      ok: false,
      skipped: "内存模式没有可备份的文件",
      detail: "内存模式未自动备份",
    };
  }
  return backupSqliteDatabase(target.path);
}
