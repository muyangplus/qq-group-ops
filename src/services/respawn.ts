import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getLogger } from "../core/logger.js";

const log = getLogger("respawn");

/** `scripts/respawn.mjs` 的绝对路径（源码运行与 `dist/main.js` 运行都指向仓库根）。 */
export function respawnHelperPath(): string {
  return fileURLToPath(new URL("../../scripts/respawn.mjs", import.meta.url));
}

export interface RespawnRequest {
  /** 即将退出的旧进程 PID（助手会等它消失再启动新进程）。 */
  pid: number;
  /** 通常就是 `process.execPath`。 */
  execPath: string;
  /** 通常就是 `process.argv.slice(1)`（入口脚本 + 参数）。 */
  args: readonly string[];
}

/** 构造交给助手的命令行（纯函数，便于单测）。 */
export function respawnCommand(
  request: RespawnRequest,
  helperPath: string,
): { command: string; args: string[] } {
  return {
    command: request.execPath,
    args: [
      helperPath,
      String(request.pid),
      request.execPath,
      ...request.args.map((arg) => String(arg)),
    ],
  };
}

export interface RespawnHandle {
  /** `spawn()` 本身是否成功（参数错误 / 可执行文件不存在会同步抛错）。 */
  readonly ok: boolean;
  readonly detail: string;
  /** 助手在启动阶段就失败了吗？（异步 `error` 事件 —— 用来撤销「退出旧进程」） */
  failed(): boolean;
}

/**
 * 脱离会话地拉起自我重启助手。
 *
 * **没有进程管理器**（直接 `node dist/main.js`）时的兜底：助手等旧进程退出后再启动新进程。
 * 调用方拿到 `handle` 后应等 `RESTART_EXIT_DELAY_MS` 再退出旧进程，并在退出前检查
 * `handle.failed()` —— 助手没起来就别退，否则机器人就真的没了。
 */
export function spawnRespawnHelper(
  request: RespawnRequest,
  helperPath: string = respawnHelperPath(),
): RespawnHandle {
  if (!existsSync(helperPath)) {
    const detail = `respawn helper not found: ${helperPath}`;
    log.error("respawn helper missing", { helperPath });
    return { ok: false, detail, failed: () => true };
  }
  const { command, args } = respawnCommand(request, helperPath);
  let failed = false;
  let detail = "";
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
      env: process.env,
    });
    child.on("error", (error) => {
      failed = true;
      detail = String(error);
      log.error("respawn helper failed to start", { error: String(error) });
    });
    child.unref();
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      failed: () => true,
    };
  }
  log.info("respawn helper started", {
    helperPath,
    oldPid: request.pid,
    platform: process.platform,
  });
  return {
    ok: true,
    detail,
    failed: () => failed,
  };
}
