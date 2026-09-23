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
