import { getLogger, type Logger } from "../core/logger.js";
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import type { AdminApiBackend } from "./backend.js";
import { adminLoginUrl, type AdminApiConfig } from "./config.js";
import { buildAdminApiServer } from "./server.js";

export interface AdminApiHostOptions {
  config: AdminApiConfig;
  /** 一次性登录令牌仓储（内存模式没有 → 调用方不该起监听口）。 */
  tokens: AdminTokenRepository;
  /** 真实服务图上的读 + 写后端（见 `backend.ts`）。 */
  backend: AdminApiBackend;
  version?: string | undefined;
  uptimeMs?: (() => number) | undefined;
  logger?: Logger | undefined;
}

export interface AdminApiHost {
  /** 监听地址（形如 `http://127.0.0.1:8787`）。 */
  url: string;
  /** 优雅关闭监听口（机器人进程退出时调用；不关数据库，那是机器人自己的连接）。 */
  close(): Promise<void>;
}

/**
 * 在**机器人进程内**起管理 API 的第二个回环监听口（E1-d）。
 *
 * 为什么不复用 webhook 那个 Fastify 实例：那个端口必须对外，管理面只在回环
 * （见 docs/ADMIN-API.md §2）。这里只是新建一个监听口，**服务图是同一份**——
 * 读写都走机器人内存里的 `GroupConfigStore` / `ActivityService` / 审计存储，
 * 因此不存在两份缓存互相覆盖、也没有第二个 tick。
 */
export async function startAdminApiHost(
  options: AdminApiHostOptions,
): Promise<AdminApiHost> {
  const log = options.logger ?? getLogger("admin-api");
  const { config, backend } = options;
  const server = buildAdminApiServer({
    config,
    tokens: options.tokens,
    version: options.version,
    uptimeMs: options.uptimeMs,
    logger: log,
    // 管理前台静态资源（默认 web/dist；目录不存在会自动跳过）
    webRoot: config.webDir,
    statusProvider: () => backend.status(),
    tasksProvider: () => backend.tasks(),
    settingsProvider: () => backend.settings(),
    auditReader: { list: () => backend.audit() },
    readers: backend,
    writers: backend,
    permissionsOf: (userId) => backend.permissionsOf(userId),
    // 只读门槛（E1-g）：与 `/auth/me` 用同一份权限画像；拒绝写审计
    readAccessOf: (userId) => backend.permissionsOf(userId),
    auditDenied: (input) => backend.auditDenied(input),
  });

  await server.app.listen({ host: config.host, port: config.port });
  // `ADMIN_API_PORT=0` 时由内核分配端口：url 要取**真实**端口，不然日志和测试都会指向 0
  const address = server.app.server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : config.port;
  const url = `http://${config.host}:${port}`;
  log.info("admin api listening (in-process)", {
    url,
    secureCookie: config.cookieSecure,
    loginUrl: config.publicBaseUrl.length > 0,
  });
  if (config.publicBaseUrl.length === 0) {
    log.warn(
      "ADMIN_API_PUBLIC_BASE_URL 未配置：/admin login 只会给出令牌，登录页需要手工粘贴。",
    );
  } else {
    // 只打一条示例，说明链接形状（真令牌在私信里，不落日志）
    log.info("admin api login link shape", {
      example: adminLoginUrl(config, "<token>"),
    });
  }

  return {
    url,
    close: async () => {
      await server.app.close().catch(() => undefined);
    },
  };
}
