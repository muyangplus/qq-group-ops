import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 重启前自检（层 4A）。
 *
 * `node dist/main.js --check` 只跑到「模块加载完成」，不接网关、不起定时器、不发重启回执，
 * 然后用**退出码**告诉调用方（`scripts/respawn.mjs`）这个版本能不能起来。
 *
 * 结果同时写一份 JSON 文件：助手不看 stdout / stderr（捕获子进程输出需要管道，
 * 受限环境里开不了），只读这个文件；人工排查也直接看它。
 */
export const STARTUP_CHECK_FLAG = "--check";

/** 自检结果文件（相对启动目录，和 `data/` 下的库文件同居；gitignored）。 */
export const STARTUP_CHECK_FILE = "data/startup-check.json";

export function isStartupCheck(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.includes(STARTUP_CHECK_FLAG);
}

/** 写自检结果（尽力而为：写不了也要靠退出码表达结果）。 */
export function writeStartupCheckFile(
  payload: Record<string, unknown>,
  file: string = STARTUP_CHECK_FILE,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...payload }),
      "utf8",
    );
  } catch {
    // 忽略：调用方仍有退出码
  }
}

/** 来自检结果；文件缺失 / 不是 JSON 时返回 `undefined`。 */
export function readStartupCheckFile(
  file: string = STARTUP_CHECK_FILE,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
