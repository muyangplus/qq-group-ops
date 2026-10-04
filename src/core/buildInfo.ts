import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/**
 * **本进程加载的那份 `build-info.json`**（启动时固化，与 `captureRunningVersion` 同一刻）。
 *
 * 为什么不在用时现读磁盘：部署替换 `dist/` 之后，磁盘上的 `build-info.json` 会变成新版本的，
 * 而这个进程跑的还是旧代码 —— 现读会把「运行中的构建」标错。所以启动时读一次就钉住，
 * `/status proc`、`/api/health` 与启动日志看的是同一份。
 */
let capturedBuildInfo: BuildInfo | undefined;

export function captureRunningBuildInfo(dir: string = DIST_DIR): BuildInfo | undefined {
  capturedBuildInfo ??= readBuildInfo(dir);
  return capturedBuildInfo;
}

/** 本进程固化的构建自证（没读到时 `undefined`：源码运行 / 老产物包没有这个文件）。 */
export function runningBuildInfo(): BuildInfo | undefined {
  return capturedBuildInfo;
}

/** 本进程固化的 commit（没有自证文件时 `undefined`，展示层据此省略该字段）。 */
export function runningCommit(): string | undefined {
  const commit = capturedBuildInfo?.commit;
  return commit !== undefined && commit.length > 0 ? commit : undefined;
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
 * - **跳过 `BUILD_INFO_FILE`**（`dist/build-info.json`）：它是构建期写的「自证」文件，
 *   里面记着**不含自己的**指纹（ADR-0065），把它算进去就永远对不上；
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
      if (file === BUILD_INFO_FILE) {
        continue;
      }
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

/**
 * 构建自证文件（**相对 `dist/` 的路径**）：CD 在构建期写进产物包，机器人侧读它做自证。
 *
 * 为什么要它（ADR-0065）：「版本号」只是 CD 跑过的标记，可能骗人（真机出现过
 * `package.json` 是 0.27.3、`dist/**` 却还是旧代码）。`build-info.json` 把
 * **版本 + commit + 构建时间 + `dist` 指纹**钉在产物里，于是：
 * - **CD 上传完成 ≠ 版本生效**：安装器解包后先用 `distFingerprint()` 与它比对，
 *   对不上就拒绝这次部署（半传 / 混装 / 改了一字节的坏包都拦在替换之前）；
 * - 启动时把它记进日志、`/healthz` 与 `/status proc`，现场一眼看出「跑的是哪次构建」。
 *
 * 关键实现：`distFingerprint()` **跳过本文件**，所以字段里的指纹就是「不含自己的那一份」——
 * 否则指纹会随自身内容变化，永远自证不过。
 */
export const BUILD_INFO_FILE = "build-info.json";

/** `dist/build-info.json` 的结构（构建期写入）。 */
export interface BuildInfo {
  version: string;
  /** 构建来源 commit（CD 的 `GITHUB_SHA`；本地构建可为空串）。 */
  commit: string;
  /** 构建时刻（ISO）。 */
  builtAt: string;
  /** `dist/` 的构建指纹（**不含 `build-info.json` 本身**）。 */
  distFingerprint?: string | undefined;
}

/** 写 `dist/build-info.json`（构建期用；指纹缺省按目标目录现算）。 */
export function writeBuildInfo(
  info: {
    version: string;
    commit: string;
    builtAt?: string;
    dir?: string;
    distFingerprint?: string | undefined;
  },
): BuildInfo {
  const dir = info.dir ?? DIST_DIR;
  const payload: BuildInfo = {
    version: info.version,
    commit: info.commit,
    builtAt: info.builtAt ?? new Date().toISOString(),
    distFingerprint: info.distFingerprint ?? distFingerprint(dir),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, BUILD_INFO_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  return payload;
}

/**
 * 读一份 `build-info.json`（缺省 `dist/build-info.json`）。
 *
 * 读不到 / 不是对象 / 版本不是非空字符串 → `undefined`：**诊断与自证失败都不该抛异常**
 * （调用方按「没有自证文件」处理，例如源码运行、老产物包）。
 */
export function readBuildInfo(dir: string = DIST_DIR): BuildInfo | undefined {
  return readBuildInfoFile(join(dir, BUILD_INFO_FILE));
}

/** 直接读某个 `build-info.json` 文件（安装器解包目录与归档包都能用）。 */
export function readBuildInfoFile(file: string): BuildInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    log.debug("build-info.json unreadable", { file, error: String(error) });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const version = record.version;
  if (typeof version !== "string" || version.length === 0) {
    return undefined;
  }
  return {
    version,
    commit: typeof record.commit === "string" ? record.commit : "",
    builtAt: typeof record.builtAt === "string" ? record.builtAt : "",
    ...(typeof record.distFingerprint === "string"
      ? { distFingerprint: record.distFingerprint }
      : {}),
  };
}

/** 自证结果：`ok` + 人话原因（失败时说清「谁和谁对不上」）。 */
export interface BuildInfoCheck {
  ok: boolean;
  detail: string;
}

/**
 * 用 `distFingerprint()` 与包内 `build-info.json` **自证**（ADR-0065 第 2 条）。
 *
 * 三种「不过」都算失败（半传 / 混装 / 坏包）：读不到自证文件、自证文件里没有指纹、
 * 或者现算指纹与它对不上。**没有指纹的旧产物包**因此不会被安装器接受 —— 这是有意的：
 * 自证是这次改动的核心，宁可在替换之前拒绝，也不要装上一份「不知道是什么」的代码。
 */
export function verifyBuildInfo(dir: string = DIST_DIR): BuildInfoCheck {
  const info = readBuildInfo(dir);
  if (!info) {
    return { ok: false, detail: `${dir}/${BUILD_INFO_FILE} 缺失或不可读` };
  }
  if (info.distFingerprint === undefined) {
    return { ok: false, detail: `${dir}/${BUILD_INFO_FILE} 里没有 distFingerprint` };
  }
  const actual = distFingerprint(dir);
  if (actual === undefined) {
    return { ok: false, detail: `${dir} 里没有可指纹的文件` };
  }
  if (actual !== info.distFingerprint) {
    return {
      ok: false,
      detail: `dist 指纹对不上：现算 ${actual}，build-info 记 ${info.distFingerprint}`,
    };
  }
  return { ok: true, detail: `指纹自证通过（${actual}）` };
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
