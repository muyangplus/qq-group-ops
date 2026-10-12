import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getLogger } from "../core/logger.js";

const log = getLogger("db-backup");

/**
 * 备份是怎么做出来的：
 *
 * - `vacuum` = `VACUUM INTO` —— **单文件一致性快照**（含 WAL 里还没 checkpoint 的提交），首选；
 * - `copy` = 老办法「拷 `.db` + `-wal` / `-shm`」—— 只作兜底（SQLite 太老不支持 `VACUUM INTO`、
 *   或者那份文件根本不是 SQLite），**两次 copy 之间可能不一致**，卡片与日志会写明。
 */
export type BackupMode = "vacuum" | "copy";

export interface BackupResult {
  /** 是否真的做了备份（PostgreSQL / 内存模式为 `false`，见 `skipped`）。 */
  ok: boolean;
  /** 没做备份时说明原因（可以直接展示）。 */
  skipped?: string;
  /** 备份文件路径（`ok=true` 时才有）。 */
  path?: string;
  /** 怎么做出来的（见 `BackupMode`）；没做备份时缺省。 */
  mode?: BackupMode | undefined;
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
 * 备份 SQLite 库：在同目录下生成 `{原名}_YYYYMMDD_HHMMSS.db`。
 *
 * 时间戳用**服务器本地时间**（和日志 / 卡片时间同一口径，方便对照）。
 *
 * **首选 `VACUUM INTO`**（ADR-0071）：它把库内容写成一个**全新的单文件快照** ——
 * 一致（含 WAL 里还没 checkpoint 的提交）、不依赖 `-wal` / `-shm` 一起拷、
 * 也不会出现「`.db` 比 `-wal` 新」那种半吊子状态。源库以**只读**连接打开，备份过程不改动它。
 *
 * 兜底：老 SQLite（< 3.27，没有 `VACUUM INTO`）或文件根本不是 SQLite 时，
 * 退回「拷 `.db` + `-wal` / `-shm`」，并在 `mode` / `detail` 里**如实标注不是原子快照**
 * （绝不假装这次备份是干净的）。
 */
export async function backupSqliteDatabase(
  sourcePath: string,
  now: Date = new Date(),
): Promise<BackupResult> {
  if (!existsSync(sourcePath)) {
    return { ok: false, detail: `数据库文件不存在：${sourcePath}` };
  }
  const target = join(dirname(sourcePath), backupNameFor(sourcePath, now));
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  }

  // ① 首选：VACUUM INTO（单文件一致快照）
  const vacuum = await tryVacuumInto(sourcePath, target);
  if (vacuum.ok) {
    log.info("sqlite database backed up", { sourcePath, target, mode: "vacuum" });
    return {
      ok: true,
      path: target,
      mode: "vacuum",
      detail: `已备份到 ${target}（VACUUM INTO 一致快照）`,
    };
  }

  // ② 兜底：拷 .db + -wal / -shm（老 SQLite / 非 SQLite 文件）
  try {
    // VACUUM INTO 失败时可能留下半个文件：先清掉，别让它冒充备份
    rmSync(target, { force: true });
    cpSync(sourcePath, target);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${sourcePath}${suffix}`)) {
        cpSync(`${sourcePath}${suffix}`, `${target}${suffix}`);
      }
    }
    log.warn("sqlite backup fell back to file copy (not atomic)", {
      sourcePath,
      target,
      reason: vacuum.detail,
    });
    return {
      ok: true,
      path: target,
      mode: "copy",
      detail: `已备份到 ${target}（兜底：文件拷贝，**不是**原子快照）`,
    };
  } catch (error) {
    const detail = describeError(error);
    log.error("sqlite backup failed", { sourcePath, error: detail });
    return { ok: false, detail };
  }
}

/**
 * `VACUUM INTO` 一次。
 *
 * 源库以**只读**打开（`VACUUM INTO` 只读源、只写目标）；`node:sqlite` 用动态 import，
 * 与 `openSqliteDatabase` 同一个理由：更早的 Node 上只配 PostgreSQL / 内存也能起来。
 * 失败不抛，返回原因给调用方决定要不要兜底。
 */
async function tryVacuumInto(
  sourcePath: string,
  targetPath: string,
): Promise<{ ok: true; detail: "" } | { ok: false; detail: string }> {
  let db: { exec(sql: string): void; close(): void } | undefined;
  try {
    const sqlite = await import("node:sqlite");
    db = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    // 目标路径按 SQL 字符串字面量转义（单个引号写成两个）
    db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
    return { ok: true, detail: "" };
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // 关闭失败无所谓：备份文件已经写完，异常留给上面的 catch
    }
  }
}

/** 按数据库目标备份：SQLite 才做，PostgreSQL / 内存模式如实说明。 */
export async function backupDatabase(target: {
  driver: "sqlite" | "postgres" | "memory";
  path?: string | undefined;
}): Promise<BackupResult> {
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
