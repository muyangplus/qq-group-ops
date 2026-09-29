#!/usr/bin/env node
/**
 * `/restart` 的自我重启助手（`node scripts/respawn.mjs <oldPid> <execPath> [args...]`）。
 *
 * 机器人自己**不能**边退边起：新进程必须等旧进程释放端口 / 数据库句柄之后才能启动。
 * 所以 `/restart` 会先把这个脚本**脱离会话**地拉起来，脚本负责：
 *
 * 1. 轮询旧 PID，直到它消失（最多等 60 秒）；
 * 2. 再等 300ms 让端口 / 文件句柄彻底释放；
 * 3. **自检**：用同样的命令跑一次 `--check`（层 4A），退出码非 0 就**不拉起新进程**，
 *    把结果写进 `data/restart-failed.json` —— 新版本起不来的话，宁可留在旧版本；
 * 4. 用同样的可执行文件 + 参数 + 工作目录拉起新进程（`detached` + `unref`）；
 * 5. 盯 3 秒：新进程立刻挂掉的话，写 `data/restart-failed.json` 留证据（尽力而为）。
 *
 * 这是**没有进程管理器**（直接 `node dist/main.js`）时的兜底方案；有 docker / systemd / pm2
 * 的部署仍然「退出靠守护拉起」更稳。脚本用纯 JS 写、随 `scripts/` 一起发布，不需要编译。
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WAIT_DEADLINE_MS = 60_000;
const SETTLE_MS = 300;
const WATCH_MS = 3_000;
/** 自检超时：卡住也算失败（宁可留在旧版本，也不要拉起一个半死不活的新进程）。 */
const CHECK_TIMEOUT_MS = 90_000;
const FAILURE_FILE = resolve("data", "restart-failed.json");
const CHECK_FILE = resolve("data", "startup-check.json");
/** 上一次「启动成功」的构建快照（`snapshotDist()` 维护）与回滚回执。 */
const BACKUP_DIR = resolve("data", "dist-backup");
const BROKEN_DIR = resolve("data", "dist-broken");
const ROLLBACK_FILE = resolve("data", "rollback-notice.json");
const DIST_DIR = "dist";
/** 与 dist 一起回滚的元文件（版本号 / 依赖锁定）。 */
const BACKUP_FILES = ["package.json", "pnpm-lock.yaml"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordFailure(payload) {
  try {
    mkdirSync(dirname(FAILURE_FILE), { recursive: true });
    writeFileSync(FAILURE_FILE, JSON.stringify(payload), "utf8");
  } catch {
    // 留证据是尽力而为：写不了就算了，别把新进程拖下水
  }
}

/**
 * 重启前自检（层 4A）：用同一套可执行文件 + 参数跑一次 `--check`。
 *
 * 新进程必须等旧进程退出后才自检（数据库 / 端口的独占），所以这里直接用同步调用：
 * 目录已经清理干净，单实例不会有并发。**不捕获它的输出**（受限环境开不了管道），
 * 只看退出码 + 它写的 `data/startup-check.json`。
 */
function runStartupCheck(execPath, args) {
  const result = spawnSync(execPath, [...args, "--check"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    timeout: CHECK_TIMEOUT_MS,
  });
  let summary;
  try {
    summary = JSON.parse(readFileSync(CHECK_FILE, "utf8"));
  } catch {
    summary = undefined;
  }
  const ok = result.status === 0 && summary?.ok !== false;
  return { ok, exitCode: result.status, signal: result.signal, summary };
}

async function main() {
  const [, , oldPidRaw, execPath, ...args] = process.argv;
  const oldPid = Number.parseInt(oldPidRaw ?? "", 10);

  if (Number.isInteger(oldPid) && oldPid > 0) {
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    while (alive(oldPid) && Date.now() < deadline) {
      await sleep(300);
    }
    if (alive(oldPid)) {
      recordFailure({
        reason: "old process still alive after deadline",
        oldPid,
        at: new Date().toISOString(),
      });
      process.exitCode = 1;
      return;
    }
  }

  await sleep(SETTLE_MS);

  if (!execPath) {
    recordFailure({ reason: "missing execPath", at: new Date().toISOString() });
    process.exitCode = 1;
    return;
  }

  const check = runStartupCheck(execPath, args);
  if (!check.ok) {
    // 层 4B：新构建起不来 → 换回上一次启动成功的快照，再自检一次；成功就照常拉起
    const rollback = rollbackDist();
    if (rollback.ok) {
      const recheck = runStartupCheck(execPath, args);
      if (recheck.ok) {
        recordRollback({
          reason: "startup check failed: rolled back to the previous dist",
          failedCheck: check.summary,
          exitCode: check.exitCode,
        });
        // 回滚后按同一套命令继续启动
        await spawnAndWatch(execPath, args);
        return;
      }
      recordFailure({
        reason: "startup check failed and the rolled-back build failed too",
        exitCode: check.exitCode,
        check: check.summary,
        recheck: recheck.summary,
        rollback: rollback.detail,
        at: new Date().toISOString(),
      });
      process.exitCode = 1;
      return;
    }
    recordFailure({
      reason: "startup check failed: not spawning the new process",
      exitCode: check.exitCode,
      signal: check.signal,
      check: check.summary,
      rollback: rollback.detail,
      at: new Date().toISOString(),
    });
    process.exitCode = 1;
    return;
  }

  await spawnAndWatch(execPath, args);
}

/**
 * 回滚 `dist/`（+ `package.json` / `pnpm-lock.yaml`）到快照。
 *
 * 现场保留在 `data/dist-broken/` 里供人工比对；`node_modules` 不参与回滚
 * （回执里会说明这一点）。
 */
function rollbackDist() {
  if (!existsSync(join(BACKUP_DIR, DIST_DIR))) {
    return { ok: false, detail: "no dist snapshot to roll back to" };
  }
  try {
    rmSync(BROKEN_DIR, { recursive: true, force: true });
    mkdirSync(dirname(BROKEN_DIR), { recursive: true });
    cpSync(DIST_DIR, join(BROKEN_DIR, DIST_DIR), { recursive: true });
    rmSync(DIST_DIR, { recursive: true, force: true });
    cpSync(join(BACKUP_DIR, DIST_DIR), DIST_DIR, { recursive: true });
    for (const file of BACKUP_FILES) {
      if (existsSync(join(BACKUP_DIR, file))) {
        cpSync(join(BACKUP_DIR, file), file);
      }
    }
    return { ok: true, detail: `restored ${DIST_DIR} from ${BACKUP_DIR}` };
  } catch (error) {
    return { ok: false, detail: `rollback failed: ${String(error)}` };
  }
}

function recordRollback(payload) {
  try {
    mkdirSync(dirname(ROLLBACK_FILE), { recursive: true });
    writeFileSync(
      ROLLBACK_FILE,
      JSON.stringify({ at: new Date().toISOString(), ...payload }),
      "utf8",
    );
  } catch {
    // 尽力而为：机器人那边收不到回执也仍然在旧版本上跑着
  }
}

/** 拉起新进程并盯 3 秒：立刻挂掉就写失败证据。 */
async function spawnAndWatch(execPath, args) {
  const child = spawn(execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();

  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    recordFailure({
      reason: "new process exited right after start",
      execPath,
      args,
      code,
      signal,
      at: new Date().toISOString(),
    });
  });
  child.on("error", (error) => {
    exited = true;
    recordFailure({
      reason: "spawn failed",
      execPath,
      args,
      error: String(error),
      at: new Date().toISOString(),
    });
  });

  // 新进程活过 3 秒就认为起来了（之后真挂了要靠日志 / 守护，脚本管不到）
  await sleep(WATCH_MS);
  if (!exited) {
    process.exitCode = 0;
  }
}

await main();
