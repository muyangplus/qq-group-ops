import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getLogger } from "../core/logger.js";

const log = getLogger("instance-lock");

/** 单实例锁文件（`data/` 下，与库文件同居；gitignored）。 */
export const INSTANCE_LOCK_FILE = "data/bot-instance.lock";

/** 被拒绝启动时留下的证据（`data/` 下；看一眼就知道是谁占着）。 */
export const DUPLICATE_INSTANCE_FILE = "data/duplicate-instance.json";

export interface InstanceLockRecord {
  /** 持有锁的进程 id。 */
  pid: number;
  /** 进程启动时刻（ISO）。 */
  startedAt: string;
  /** 那份进程的运行版本（诊断用）。 */
  version: string;
}

export interface InstanceLockOptions {
  file?: string;
  pid?: number;
  version: string;
  now?: () => Date;
  /** 探活实现（测试注入；默认 `process.kill(pid, 0)`）。 */
  isAlive?: (pid: number) => boolean;
}

/** 进程是否还活着：`kill(pid, 0)` 不发信号，只探活（`EPERM` 也算活着）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在、只是不归我们管（也算活着）；ESRCH = 确实没了
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/** 读锁文件；读不到 / 坏文件当没有。 */
export function readInstanceLock(
  file: string = INSTANCE_LOCK_FILE,
): InstanceLockRecord | undefined {
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<InstanceLockRecord>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
    };
  } catch (error) {
    log.warn("instance lock unreadable, treating as absent", {
      file,
      error: String(error),
    });
    return undefined;
  }
}

/**
 * 抢占单实例锁。
 *
 * 为什么需要它：真机上出现过**两个 `node dist/main.js` 同时从同一个应用目录跑**
 * （都是自我重启助手拉起的游离进程，父进程是 init）—— 两个进程各自：
 * ① 扫到新版本、各发一张「发现新版本」；② 各重启一次；③ 各自连网关、各跑一套周期任务
 * （包括定时发言，会重复发言）；④ 同时写同一个 SQLite。
 * 部署监测的「同一目标版本不再排第二轮」是**进程内**记忆，天然拦不住这种情形，
 * 所以要在**启动时**就把第二个进程拦在门外（见 ADR-0064）。
 *
 * 判据刻意简单（跨平台、无依赖）：锁文件里的 pid 还活着且不是自己 → 拒绝启动；
 * 进程已退出（崩溃 / 被 kill）→ 直接接管。自我重启的交接是安全的：
 * `scripts/respawn.mjs` 会等旧进程退出后才拉起新进程，那时锁里的 pid 已经死了。
 */
export function acquireInstanceLock(
  options: InstanceLockOptions,
): { ok: true } | { ok: false; holder: InstanceLockRecord } {
  const file = options.file ?? INSTANCE_LOCK_FILE;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const holder = readInstanceLock(file);
  if (holder && holder.pid !== pid && isAlive(holder.pid)) {
    return { ok: false, holder };
  }
  const record: InstanceLockRecord = {
    pid,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    version: options.version,
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record), "utf8");
  } catch (error) {
    // 尽力而为：写不了锁文件不该拦住启动（宁可没有这层保护，也不能让机器人起不来）
    log.warn("instance lock not written", { file, error: String(error) });
  }
  return { ok: true };
}

/** 放弃锁（只在自己持有的时候删；退出前调用）。 */
export function releaseInstanceLock(
  options: { file?: string; pid?: number } = {},
): boolean {
  const file = options.file ?? INSTANCE_LOCK_FILE;
  const pid = options.pid ?? process.pid;
  const holder = readInstanceLock(file);
  if (!holder || holder.pid !== pid) {
    return false;
  }
  try {
    rmSync(file, { force: true });
    return true;
  } catch (error) {
    log.warn("instance lock not removed", { file, error: String(error) });
    return false;
  }
}

/**
 * 记下「检测到重复实例、本进程拒绝启动」的证据（`data/duplicate-instance.json`）。
 *
 * 为什么留文件而不是只打日志：这是运维事件（有人多起了一份），
 * 文件在 `data/` 里比翻日志快，也方便事后确认「那次部署为什么没生效」。
 */
export function writeDuplicateEvidence(
  input: { holder: InstanceLockRecord; pid: number; file?: string },
): boolean {
  const file = input.file ?? DUPLICATE_INSTANCE_FILE;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        refusedPid: input.pid,
        holder: input.holder,
        at: new Date().toISOString(),
        hint:
          "另一个机器人进程正在运行（同一个应用目录只能有一份）：" +
          "先确认 `ps -ef | grep dist/main.js`，只留一份再启动。",
      }),
      "utf8",
    );
    return true;
  } catch (error) {
    log.warn("duplicate instance evidence not written", {
      file,
      error: String(error),
    });
    return false;
  }
}
