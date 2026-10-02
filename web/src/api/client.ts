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
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
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
  get: <T>(path: string): Promise<T> => request<T>("GET", path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>("PUT", path, body),
};
