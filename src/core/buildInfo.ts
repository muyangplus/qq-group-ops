import { readFileSync } from "node:fs";

import { getLogger } from "./logger.js";

const log = getLogger("build-info");

/**
 * 构建 / 进程信息（`/status` 的进程行与 `/status proc` 用）。
 *
 * 版本号直接读仓库根的 `package.json`：`dist/core/buildInfo.js` 往上两级就是包根，
 * 而 CD 产物也把 `package.json` 一起发布，所以源码运行与产物运行都能读到；
 * 读不到时回落 `unknown` —— 诊断信息永远不能让指令或启动失败。
 */
let cachedVersion: string | undefined;

export function appVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  try {
    const raw = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion =
      typeof parsed.version === "string" && parsed.version.length > 0
        ? parsed.version
        : "unknown";
  } catch (error) {
    log.debug("package.json unreadable, version falls back to unknown", {
      error: String(error),
    });
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

/** 进程启动时刻（`process.uptime()` 反推）。 */
export function processStartedAt(now: number = Date.now()): Date {
  return new Date(now - Math.round(process.uptime() * 1000));
}

/** 毫秒 → 「3天 2小时5分」/「12分30秒」这种短写法。 */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}天 ${hours}小时${minutes}分`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes}分`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

/** 字节 → 「128.0 MB」/「1.25 GB」。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  const mb = bytes / (1_024 * 1_024);
  return mb >= 1_024 ? `${(mb / 1_024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}
