/** 官方限流相关错误码：100017 接口频率限制，40023001 请求过于频繁，22009 消息发送频率限制。 */
export const RATE_LIMIT_ERROR_CODES: ReadonlySet<number> = new Set([
  100017,
  40023001,
  22009,
]);

export interface QQOfficialAPIErrorOptions {
  errorCode?: number | undefined;
  retryAfterMs?: number | undefined;
}

export class QQOfficialAPIError extends Error {
  public readonly errorCode: number | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(
    public readonly statusCode: number,
    message: string,
    public readonly payload?: unknown,
    options: QQOfficialAPIErrorOptions = {},
  ) {
    super(`QQ official API error ${statusCode}: ${message}`);
    this.name = "QQOfficialAPIError";
    this.errorCode = options.errorCode;
    this.retryAfterMs = options.retryAfterMs;
  }

  public get isRateLimited(): boolean {
    if (this.errorCode !== undefined && RATE_LIMIT_ERROR_CODES.has(this.errorCode)) {
      return true;
    }
    if (this.statusCode === 429) {
      return true;
    }
    return /频率|限流|过于频繁|too many requests|rate ?limit/iu.test(this.message);
  }
}

/** 判断任意异常是否为官方限流错误。 */
export function isRateLimitedError(error: unknown): boolean {
  return error instanceof QQOfficialAPIError && error.isRateLimited;
}

/**
 * 「**结果未知**」的失败：我们**没等到 HTTP 响应**（超时 / 连接被掐断 / fetch 直接抛）。
 *
 * 为什么要单独判：消息发送是**非幂等**的 —— 超时只说明「我们没收到响应」，
 * 平台很可能已经把它发出去了。这时候再自动重试（或换一种形态再发一次）就会让用户
 * 看到**两条一样的消息**（真机报过「一次部署两条『发现新版本』」，间隔正好是
 * 超时 + 退避的时间）。所以发送路径上：**结果未知 = 不重试**（宁可少一条，不要重复两条），
 * 只有**明确失败**（拿到响应、限流、连都没连上）才继续退避重试（见 ADR-0063）。
 *
 * 判据故意保守：
 * - 拿不到响应且不是「连接压根没建立」（`ENOTFOUND` / `ECONNREFUSED` 这类）→ 结果未知；
 * - 有 HTTP 响应（`QQOfficialAPIError`）→ 已知失败（请求确实没被接受）；
 * - 形态像超时 / 连接中断（`TimeoutError` / `AbortError` / `ECONNRESET` / socket hang up …）→ 结果未知。
 */
export function isUnknownOutcomeError(error: unknown): boolean {
  if (error instanceof QQOfficialAPIError) {
    return false;
  }
  const raw = error as
    | { name?: unknown; code?: unknown; cause?: { code?: unknown } | undefined }
    | null
    | undefined;
  const name = typeof raw?.name === "string" ? raw.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return true;
  }
  const code =
    typeof raw?.cause?.code === "string"
      ? raw.cause.code
      : typeof raw?.code === "string"
        ? raw.code
        : "";
  // 连都没连上：请求肯定没有送到平台，可以安全重试
  if (["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"].includes(code)) {
    return false;
  }
  if (
    [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /timeout|timed out|aborted|socket hang up|ECONNRESET|EPIPE/iu.test(message);
}
