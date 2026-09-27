#!/usr/bin/env node
/**
 * `/restart` 的自我重启助手（`node scripts/respawn.mjs <oldPid> <execPath> [args...]`）。
 *
 * 机器人自己**不能**边退边起：新进程必须等旧进程释放端口 / 数据库句柄之后才能启动。
 * 所以 `/restart` 会先把这个脚本**脱离会话**地拉起来，脚本负责：
 *
 * 1. 轮询旧 PID，直到它消失（最多等 60 秒）；
 * 2. 再等 300ms 让端口 / 文件句柄彻底释放；
 * 3. 用同样的可执行文件 + 参数 + 工作目录拉起新进程（`detached` + `unref`）；
 * 4. 盯 3 秒：新进程立刻挂掉的话，写 `data/restart-failed.json` 留证据（尽力而为）。
 *
 * 这是**没有进程管理器**（直接 `node dist/main.js`）时的兜底方案；有 docker / systemd / pm2
 * 的部署仍然「退出靠守护拉起」更稳。脚本用纯 JS 写、随 `scripts/` 一起发布，不需要编译。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WAIT_DEADLINE_MS = 60_000;
const SETTLE_MS = 300;
const WATCH_MS = 3_000;
const FAILURE_FILE = resolve("data", "restart-failed.json");

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
