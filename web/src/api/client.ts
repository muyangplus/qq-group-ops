/**
 * 管理 API 的最小客户端（E2-a）。
 *
 * 约定：
 * - **同源请求**：部署时后台静态资源与管理 API 同源（见 docs/ADMIN-API.md 的 E2-e），
 *   开发期由 vite 代理转发，所以这里用相对路径、不配 base URL，也不涉及 CORS；
 * - **凭据**：会话是 `HttpOnly + SameSite=Strict` 的 cookie，浏览器自动带上，前端不碰 token；
 * - **CSRF**：写操作（非 GET）必须带 `X-Admin-Request: 1`，缺了服务端回 403；
 * - **错误**：统一抛 `ApiError`（带 HTTP 状态与机器可读的 `error` 码），调用方按状态分支。
 */

export interface ApiErrorBody {
  error: string;
  message: string;
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    /** 服务端给的机器可读错误码：`unauthorized` / `forbidden` / `csrf` / `bad_request` … */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 会话失效（401）时的全局回调（E2-b）：路由层注册一次，把用户送回登录页。
 *
 * 为什么放在客户端模块里：401 可能来自任何一个 API 调用（cookie 过期、换过
 * `ADMIN_API_SESSION_SECRET`、机器人重启），散在每个页面里处理一定会漏。
 */
let unauthorizedHandler: (() => void) | undefined;

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions {
  /**
   * 401 不当成「会话刚失效」（`/auth/me` 用它）：
   * 「我还没登录」是正常分支，不该触发全局跳登录，否则会和路由守卫互相打断。
   */
  silent401?: boolean | undefined;
}

function parseBody(text: string): unknown {
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 反代返回的 HTML 错误页也算「非预期响应」，交给下面的 status 分支
    return {};
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    headers["X-Admin-Request"] = "1";
  }
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(payload !== undefined ? { body: payload } : {}),
  });

  const data = parseBody(await response.text());
  if (!response.ok) {
    if (response.status === 401 && options.silent401 !== true) {
      unauthorizedHandler?.();
    }
    const errorBody = data as Partial<ApiErrorBody>;
    throw new ApiError(
      response.status,
      typeof errorBody.error === "string" ? errorBody.error : "error",
      typeof errorBody.message === "string"
        ? errorBody.message
        : `请求失败（HTTP ${response.status}）`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>("GET", path, undefined, options ?? {}),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>("PUT", path, body),
  /** 删除（例如把一项配置恢复成 `.env` 默认值）；同样要带 CSRF 头。 */
  del: <T>(path: string): Promise<T> => request<T>("DELETE", path),
};
