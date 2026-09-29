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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WAIT_DEADLINE_MS = 60_000;
const SETTLE_MS = 300;
const WATCH_MS = 3_000;
/** 自检超时：卡住也算失败（宁可留在旧版本，也不要拉起一个半死不活的新进程）。 */
const CHECK_TIMEOUT_MS = 90_000;
const FAILURE_FILE = resolve("data", "restart-failed.json");
const CHECK_FILE = resolve("data", "startup-check.json");

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
    recordFailure({
      reason: "startup check failed: not spawning the new process",
      exitCode: check.exitCode,
      signal: check.signal,
      check: check.summary,
      at: new Date().toISOString(),
    });
    process.exitCode = 1;
    return;
  }

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
