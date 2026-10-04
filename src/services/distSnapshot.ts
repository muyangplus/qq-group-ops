import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { appVersion, DIST_DIR } from "../core/buildInfo.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("dist-snapshot");

/** 运行产物目录（CD 上传的就是它）；常量与构建指纹共用一处（`core/buildInfo.ts`）。 */
export { DIST_DIR };

/** 「上一次启动成功」的构建快照：新版本自检不过时，助手从这里回滚。 */
export const DIST_BACKUP_DIR = "data/dist-backup";

/** 被换下来的坏构建留证目录（存在就说明历史上回滚过一次）。 */
export const DIST_BROKEN_DIR = "data/dist-broken";

/** 与 `dist/` 一起回滚的元文件（版本号 / 依赖锁定）。 */
export const DIST_BACKUP_FILES: readonly string[] = [
  "package.json",
  "pnpm-lock.yaml",
];

/** 回滚回执：助手回滚后写，机器人启动时读取并私信超管。 */
export const ROLLBACK_NOTICE_FILE = "data/rollback-notice.json";

export interface SnapshotResult {
  ok: boolean;
  /** 快照进去的文件数。 */
  files: number;
  detail?: string;
}

/**
 * 把**当前构建**快照成「上一次启动成功」的版本（覆盖旧快照）。
 *
 * 调用时机是「本进程已经初始化成功」之后，因此快照里的构建一定起得来 ——
 * 下一次升级自检不过时，助手就用它回滚。失败只记日志：快照是兜底，不该影响启动。
 */
export function snapshotDist(
  dist: string = DIST_DIR,
  backup: string = DIST_BACKUP_DIR,
  extras: readonly string[] = DIST_BACKUP_FILES,
): SnapshotResult {
  try {
    if (!existsSync(dist)) {
      return { ok: false, files: 0, detail: `${dist} 不存在` };
    }
    rmSync(backup, { recursive: true, force: true });
    mkdirSync(dirname(backup), { recursive: true });
    // 快照目录里统一放一份 `dist/`（助手按 `data/dist-backup/dist` 回滚）
    const target = join(backup, basename(dist));
    cpSync(dist, target, { recursive: true });
    let files = countFiles(target);
    // 元文件按**应用根目录**（`dist/` 的上一级）解析，而不是调用方的工作目录
    const root = dirname(dist);
    for (const extra of extras) {
      const source = join(root, extra);
      if (existsSync(source)) {
        cpSync(source, join(backup, extra));
        files += 1;
      }
    }
    writeFileSync(
      join(backup, "manifest.json"),
      `${JSON.stringify(
        { at: new Date().toISOString(), version: appVersion(), files, dist },
        null,
        2,
      )}\n`,
      "utf8",
    );
    log.info("dist snapshot updated", { backup, files });
    return { ok: true, files };
  } catch (error) {
    const detail = describeError(error);
    log.warn("dist snapshot failed", { backup, error: detail });
    return { ok: false, files: 0, detail };
  }
}

export interface RollbackNotice {
  at: string;
  /** 回滚原因（助手写的人类可读说明）。 */
  reason: string;
  /** 自检结果文件的内容（哪个环节没过）。 */
  check?: unknown;
}

export interface RestoreResult {
  ok: boolean;
  detail: string;
}

/**
 * 用快照**换回上一版**（自检不过时该做的兜底）。
 *
 * 现场（现役 `dist/`）挪到 `data/dist-broken/` 留证，再从 `data/dist-backup/` 还原
 * `dist/` 与元文件。返回失败原因时调用方只记日志 —— 换不回来也不该影响当前进程继续跑。
 */
export function restoreDistFromBackup(
  dist: string = DIST_DIR,
  backup: string = DIST_BACKUP_DIR,
  broken = "data/dist-broken",
  extras: readonly string[] = DIST_BACKUP_FILES,
): RestoreResult {
  const source = join(backup, basename(dist));
  if (!existsSync(source)) {
    return {
      ok: false,
      detail: "没有可回滚的构建快照（data/dist-backup 不存在）",
    };
  }
  try {
    rmSync(broken, { recursive: true, force: true });
    mkdirSync(dirname(broken), { recursive: true });
    cpSync(dist, join(broken, basename(dist)), { recursive: true });
    rmSync(dist, { recursive: true, force: true });
    cpSync(source, dist, { recursive: true });
    for (const extra of extras) {
      const from = join(backup, extra);
      if (existsSync(from)) {
        cpSync(from, join(dirname(dist), extra));
      }
    }
    log.warn("dist restored from backup", { dist, backup, broken });
    return {
      ok: true,
      detail: `坏构建已挪到 ${broken}，并从快照还原 ${dist}`,
    };
  } catch (error) {
    const detail = describeError(error);
    log.error("dist restore failed", { dist, backup, error: detail });
    return { ok: false, detail };
  }
}

/** 读回滚回执但**不删除**（管理后台的运维只读视图用；机器人自己启动时用 `takeRollbackNotice`）。 */
export function readRollbackNotice(
  file: string = ROLLBACK_NOTICE_FILE,
): RollbackNotice | undefined {
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    return JSON.parse(readFileSync(file, "utf8")) as RollbackNotice;
  } catch (error) {
    log.warn("rollback notice unreadable", { error: describeError(error) });
    return undefined;
  }
}

/** 读走回滚回执（读后删除，避免重复私信）。 */
export function takeRollbackNotice(
  file: string = ROLLBACK_NOTICE_FILE,
): RollbackNotice | undefined {
  const notice = readRollbackNotice(file);
  if (notice === undefined) {
    return undefined;
  }
  try {
    rmSync(file, { force: true });
  } catch (error) {
    log.warn("rollback notice not removed", { error: describeError(error) });
  }
  return notice;
}

/** 助手回滚成功后写回执（纯 JS 的 `scripts/respawn.mjs` 也会写同样的结构）。 */
export function writeRollbackNotice(
  notice: RollbackNotice,
  file: string = ROLLBACK_NOTICE_FILE,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(notice), "utf8");
  } catch (error) {
    log.warn("rollback notice write failed", { error: describeError(error) });
  }
}

/** CD 的 FTP 同步状态文件名（`SamKirkland/FTP-Deploy-Action` 的 `state-name`，两段各一份）。 */
export const SYNC_STATE_PATTERN = /^ftp-sync-state-.*\.json$/u;

/**
 * 删掉自家 FTP 同步状态（`ftp-sync-state-*.json`），返回被删的文件名。
 *
 * 为什么必须主动作废（ADR-0065 第 5 条）：**我们自己绕过了同步器改了 `dist/`**
 * （回滚 / 机器人自解包），而同步状态记的是「上次我传过什么」——
 * 于是下一轮 CD 会因为「本地文件没变」而**跳过上传**，出现「版本号升了、代码还是旧的」。
 * 作废之后下一轮 CD 全量上传（**一次性**，不是每次都全量）。
 *
 * 只删这一种名字的文件：其它任何文件都不碰。
 */
export function removeSyncStateFiles(root: string = "."): string[] {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => SYNC_STATE_PATTERN.test(name));
  } catch (error) {
    log.debug("sync state scan failed", { root, error: describeError(error) });
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    try {
      rmSync(join(root, name), { force: true });
      removed.push(name);
    } catch (error) {
      log.warn("sync state removal failed", {
        file: join(root, name),
        error: describeError(error),
      });
    }
  }
  if (removed.length > 0) {
    log.warn("ftp sync state invalidated (next CD uploads in full)", { root, removed });
  }
  return removed;
}

/** `removeSyncStateFiles()` 的人话描述（回执与日志用）。 */
export function describeSyncStateFiles(root: string = "."): string {
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((name) => SYNC_STATE_PATTERN.test(name));
  } catch {
    return "";
  }
  return names.join(" / ");
}

function countFiles(path: string): number {
  return readdirSync(path, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile(),
  ).length;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
