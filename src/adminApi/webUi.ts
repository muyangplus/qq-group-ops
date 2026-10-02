import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import { getLogger, type Logger } from "../core/logger.js";

/**
 * 由管理 API 直接托管管理前台（`web/dist`）——「同源」的最省事形态。
 *
 * 为什么加这个：管理前台原本约定交给 nginx 托管（`root` + `try_files`），但实践里
 * **「整个域名反代到 8787」才是最省心的部署**：机器人自己就是 Fastify，静态文件顺手就发了。
 * 于是这里把 `web/dist`（可用 `ADMIN_API_WEB_DIR` 改）挂到管理监听口上：
 *
 * - 只处理 GET / HEAD；`/api/*`、`/auth/*`、`/healthz` 一律不碰（交给各自的处理器）；
 * - 导航请求（没有扩展名的路径，如 `/`、`/login`、`/pending`）找不到文件时回退 `index.html`
 *   —— 这是 SPA 的标准做法（等价于 `try_files $uri $uri/ /index.html`）；
 *   **带扩展名的请求不回退**，避免 `GET /assets/missing.js` 拿到一坨 HTML；
 * - 站点目录不存在就**完全不注册**（没构建前端 / 老部署的行为不变：404 + 一句提示）；
 * - 路径穿越（`..`、绝对路径、NUL 字节）全部挡掉。
 *
 * 想继续交给 nginx 托管也完全没问题：把 `ADMIN_API_WEB_DIR` 留空即可。
 */
export interface WebUiOptions {
  /** 站点根目录（通常是 `web/dist`；相对路径按进程工作目录解析）。 */
  root: string;
  logger?: Logger | undefined;
  /** 单文件上限（字节）：防止误放进来的大文件把内存打满。默认 8 MiB。 */
  maxBytes?: number | undefined;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** 注册成功返回 `true`；目录不存在（没构建前端）或显式留空时返回 `false`。 */
export function registerWebUi(app: FastifyInstance, options: WebUiOptions): boolean {
  const log = options.logger ?? getLogger("admin-api");
  const limit = options.maxBytes ?? 8 * 1024 * 1024;
  const configured = options.root.trim();
  const root = resolve(configured.length > 0 ? configured : "web/dist");

  if (configured.length === 0 || !existsSync(root)) {
    log.info("admin web ui not registered", {
      root,
      hint:
        configured.length === 0
          ? "ADMIN_API_WEB_DIR 留空：静态资源交给 nginx 等外部托管。"
          : "没找到站点目录（未构建 / 未部署前端？）：`/`、`/login` 等页面会回 404，接口不受影响。",
    });
    return false;
  }

  const handler = async (
    request: { method: string; raw: { url?: string | undefined } },
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.callNotFound();
    }
    const urlPath = (request.raw.url ?? "/").split("?")[0] ?? "/";
    // 管理 API 自己的前缀永远不碰（路由优先级已经保证了这点，这里再兜一层）
    if (
      urlPath.startsWith("/api/") ||
      urlPath.startsWith("/auth/") ||
      urlPath === "/healthz"
    ) {
      return reply.callNotFound();
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return reply.callNotFound();
    }
    if (decoded.includes("\0")) {
      return reply.code(400).send({ error: "bad_request", message: "非法路径。" });
    }

    const candidate = resolve(root, decoded.replace(/^\/+/u, ""));
    if (!isInside(root, candidate)) {
      return reply.code(403).send({ error: "forbidden", message: "非法路径。" });
    }

    const file = await pickFile(candidate, limit);
    if (file) {
      return sendFile(reply, request.method === "HEAD", file, root, log);
    }
    // 导航请求（无扩展名）回退 index.html；带扩展名的按 404 处理
    if (extname(decoded).length === 0) {
      const index = await pickFile(join(root, "index.html"), limit);
      if (index) {
        return sendFile(reply, request.method === "HEAD", index, root, log);
      }
    }
    return reply.callNotFound();
  };

  // `/*` 在 find-my-way 里通常也能命中 `/`，但两个都注册更稳妥（同一处理器）
  app.get("/", handler);
  app.get("/*", handler);
  log.info("admin web ui registered", { root });
  return true;
}

/** 目标必须在站点根目录里（挡掉 `..` 与绝对路径）。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 命中文件返回它；目录则尝试 `index.html`；不存在 / 非普通文件 / 太大都返回 `undefined`。 */
async function pickFile(path: string, limit: number): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    return undefined;
  }
  if (info.isFile()) {
    return info.size > limit ? undefined : path;
  }
  if (info.isDirectory()) {
    const index = join(path, "index.html");
    const indexInfo = await stat(index).catch(() => undefined);
    if (indexInfo?.isFile() && indexInfo.size <= limit) {
      return index;
    }
  }
  return undefined;
}

async function sendFile(
  reply: FastifyReply,
  headOnly: boolean,
  file: string,
  root: string,
  log: Logger,
): Promise<unknown> {
  try {
    const body = await readFile(file);
    reply.header(
      "content-type",
      MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    );
    reply.header("cache-control", cacheControl(file, root));
    return headOnly ? reply.send() : reply.send(body);
  } catch (error) {
    log.warn("admin web ui read failed", {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return reply.callNotFound();
  }
}

/** `assets/` 下的文件名带内容哈希 → 可以长缓存；`index.html` 等必须每次回源。 */
function cacheControl(file: string, root: string): string {
  const rel = relative(root, file).split("\\").join("/");
  if (rel.startsWith("assets/") && extname(rel).length > 0) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}
