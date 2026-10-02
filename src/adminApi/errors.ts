/**
 * 管理 API 的请求错误（E1-d）。
 *
 * 领域层（`backend.ts`）在**写操作**里抛它，HTTP 层统一映射成状态码 + `{error, message}`
 * 响应体：这样「权限不足」「参数非法」「对象不存在」「已经被处理」的判定留在领域层
 * （与指令层同一判据），HTTP 层不重复实现一遍业务规则。
 */
export class AdminApiRequestError extends Error {
  public constructor(
    /** 直接返回给调用方的 HTTP 状态码。 */
    public readonly statusCode: 400 | 403 | 404 | 409 | 503,
    /** 机器可读的错误码（`forbidden` / `bad_request` / `not_found` / `conflict` / `unavailable`）。 */
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiRequestError";
  }
}

/** 权限不足（403）：调用方已登录，但没到这条写操作的门槛。 */
export function forbidden(message: string): AdminApiRequestError {
  return new AdminApiRequestError(403, "forbidden", message);
}

/** 参数非法（400）：缺字段、值解析失败等。 */
export function badRequest(message: string): AdminApiRequestError {
  return new AdminApiRequestError(400, "bad_request", message);
}

/** 目标不存在（404）。 */
export function notFound(message: string): AdminApiRequestError {
  return new AdminApiRequestError(404, "not_found", message);
}

/** 状态冲突（409）：例如别人已经处理过这条申请。 */
export function conflict(message: string): AdminApiRequestError {
  return new AdminApiRequestError(409, "conflict", message);
}

/** 本进程没有这项能力（503）：例如只读巡检进程里没有内存态配置存储。 */
export function unavailable(message: string): AdminApiRequestError {
  return new AdminApiRequestError(503, "unavailable", message);
}
