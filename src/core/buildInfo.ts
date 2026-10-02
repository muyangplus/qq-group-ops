import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

/** 每次重新读**磁盘**上的版本（部署监测用：磁盘会被 CD 覆盖成新版本）。 */
export function onDiskVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "unknown";
  } catch (error) {
    log.debug("package.json unreadable", { error: String(error) });
    return "unknown";
  }
}

/**
 * **本进程正在运行的版本**（进程启动时固化）。
 *
 * 关键：`appVersion()` 读的是磁盘版本，部署之后它会变成新版本，但当前进程跑的还是旧代码 ——
 * 部署监测拿「磁盘版本 ≠ 固化版本」当信号，不在启动时固化就永远触发不了。
 */
let capturedVersion: string | undefined;

export function captureRunningVersion(version: string = appVersion()): string {
  capturedVersion ??= version;
  return capturedVersion;
}

export function runningVersionOf(): string {
  return capturedVersion ?? appVersion();
}

/** 运行产物目录（CD 上传的就是它）；指纹只看它，不看版本号文件。 */
export const DIST_DIR = "dist";

/**
 * `dist/` 的构建指纹（**内容**哈希）：产物内容真的变了才会变。
 *
 * 为什么要它：部署监测原本只看「磁盘 `package.json` 版本 ≠ 进程启动时固化的版本」。
 * FTP 逐文件上传没有「传完」信号，进程完全可能在「新代码已经落地、`package.json` 还没落地」
 * 的窗口里启动（CD 上传途中重启、或上传没完就手动重启）—— 那种情况下这份进程**跑的已经是最新
 * 代码**，可随后落地的版本号仍会被当成一次新部署，于是宽限期到点又白跳一次重启（真机报过：
 * 一次部署跳两次）。有了指纹就能把「版本号变了」与「代码真的换了」分开。
 *
 * 实现口径：
 * - 只哈希相对路径 + 每个文件的 sha1（**不用 mtime**：CD 重传同内容会改 mtime，那是假信号）；
 * - `dist/` 不存在（源码直跑 `pnpm dev`）或读不动 → 返回 `undefined`，调用方**退回版本号判据**；
 * - 指纹只是判据优化，任何异常都只记日志，绝不让部署监测失效。
 */
export function distFingerprint(dir: string = DIST_DIR): string | undefined {
  try {
    const files = listFiles(dir);
    if (files.length === 0) {
      return undefined;
    }
    const hash = createHash("sha1");
    for (const file of files) {
      hash.update(file);
      hash.update("\0");
      hash.update(createHash("sha1").update(readFileSync(join(dir, file))).digest("hex"));
      hash.update("\n");
    }
    return hash.digest("hex");
  } catch (error) {
    log.debug("dist fingerprint unavailable", { dir, error: String(error) });
    return undefined;
  }
}

/** 递归列出目录下所有文件（相对路径，正斜杠分隔，已排序）。 */
function listFiles(dir: string, prefix = ""): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      names.push(...listFiles(join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      names.push(relative);
    }
  }
  return names.sort();
}

export function appVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  cachedVersion = onDiskVersion();
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
