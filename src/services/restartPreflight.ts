import { spawnSync } from "node:child_process";

import { readStartupCheckFile } from "../startupCheck.js";

/** 自检结果：`ok=false` 时 `reason` 可以直接展示给超管。 */
export interface PreflightResult {
  ok: boolean;
  /** 退出码（超时 / 被杀时为 null）。 */
  exitCode: number | null;
  /** `data/startup-check.json` 的内容（可能没有）。 */
  summary?: Record<string, unknown>;
  reason?: string;
}

export interface PreflightOptions {
  /** 通常 `process.execPath`。 */
  execPath: string;
  /** 通常 `process.argv.slice(1)`（入口脚本 + 参数）。 */
  args: readonly string[];
  timeoutMs?: number;
  /** 自检结果文件；测试可换成临时路径。 */
  checkFile?: string;
}

/** 自检默认超时：卡住也算失败（宁可这次不重启，也不要冒险退出）。 */
export const PREFLIGHT_TIMEOUT_MS = 90_000;

/**
 * **退出前**自检：用同样的命令跑一次 `--check`。
 *
 * 关键在什么时候跑：旧进程**退出之前**跑，跑不过就**不退出** —— 最坏情况只是「这次重启没生效」，
 * 而不是「旧进程已经退出、新进程又起不来 → 机器人没了」。助手侧那份检查仍然保留，兜
 * 「检查通过之后环境又变了」这种极小概率。
 */
export function runRestartPreflight(options: PreflightOptions): PreflightResult {
  const result = spawnSync(options.execPath, [...options.args, "--check"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    timeout: options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
  });
  const summary = readStartupCheckFile(options.checkFile);
  if (result.status === 0 && summary?.ok !== false) {
    return { ok: true, exitCode: 0, ...(summary ? { summary } : {}) };
  }
  return {
    ok: false,
    exitCode: result.status,
    ...(summary ? { summary } : {}),
    reason: describeFailure(result.status, result.signal, summary),
  };
}

function describeFailure(
  status: number | null,
  signal: NodeJS.Signals | null,
  summary: Record<string, unknown> | undefined,
): string {
  if (status === null) {
    return `自检进程没有正常结束（${signal ?? "超时或被杀"}）`;
  }
  const error = summary?.error;
  if (typeof error === "string" && error.length > 0) {
    return `自检退出码 ${status}：${error}`;
  }
  return `自检退出码 ${status}（详见 data/startup-check.json）`;
}

export interface FailedVersionRecord {
  version: string;
  reason: string;
  kind: "manual" | "deploy";
  at: string;
}

/**
 * 「这个构建自检不过」的短期记忆。
 *
 * 只存在**进程内**：旧进程没退出，所以这份记忆一直有效。它要挡的是
 * 「部署监测每 5 分钟重试同一个坏版本」这种死循环；磁盘版本一换就自然失效（`forget`）。
 */
export class FailedVersionGuard {
  private readonly failed = new Map<string, FailedVersionRecord>();

  public markFailed(
    version: string | undefined,
    reason: string,
    kind: "manual" | "deploy",
  ): void {
    if (version !== undefined && version.length > 0) {
      this.failed.set(version, {
        version,
        reason,
        kind,
        at: new Date().toISOString(),
      });
    }
  }

  public get(version: string | undefined): FailedVersionRecord | undefined {
    return version === undefined ? undefined : this.failed.get(version);
  }

  public isFailed(version: string | undefined): boolean {
    return this.get(version) !== undefined;
  }

  /** 磁盘版本换了 / 自检通过后清掉（新构建重新给一次机会）。 */
  public forget(version: string | undefined): void {
    if (version !== undefined) {
      this.failed.delete(version);
    }
  }

  public clear(): void {
    this.failed.clear();
  }
}
