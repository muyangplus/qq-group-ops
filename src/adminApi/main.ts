import { getLogger } from "../core/logger.js";
import { loadSettings } from "../config.js";
import { connectPersistence } from "../persistence.js";
import { adminLoginUrl, loadAdminApiConfig } from "./config.js";
import { buildAdminApiServer } from "./server.js";

/**
 * 管理 API 进程入口（E1，认证方案 B2）。
 *
 * 独立进程、默认只监听 `127.0.0.1`（见 docs/ADMIN-API.md §2）：与机器人进程隔离，
 * 管理面崩了不影响收消息，webhook 端口也不用跟着暴露。
 *
 * 启动：`pnpm admin:api`（需要先 `pnpm build`，或开发时用 `tsx src/adminApi/main.ts`）。
 * 未开启（`ADMIN_API_ENABLED` 非 true）时**什么都不做**，不监听端口。
 */
async function main(): Promise<void> {
  const log = getLogger("admin-api");
  const config = loadAdminApiConfig();
  if (!config.enabled) {
    log.info("admin api disabled", { hint: "ADMIN_API_ENABLED 未开启，未监听任何端口。" });
    return;
  }

  const settings = loadSettings();
  const persistence = await connectPersistence(settings);
  if (!persistence) {
    throw new Error(
      "管理 API 需要数据库：DATABASE_URL=memory 时无法签发/兑换登录令牌。",
    );
  }

  const server = buildAdminApiServer({
    config,
    tokens: persistence.adminTokens,
    version: process.env.npm_package_version ?? "unknown",
    uptimeMs: () => Math.round(process.uptime() * 1000),
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    log.info("admin api shutting down", { signal });
    await server.app.close().catch(() => undefined);
    await persistence.close().catch(() => undefined);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.app.listen({ host: config.host, port: config.port });
  log.info("admin api listening", {
    host: config.host,
    port: config.port,
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
}

main().catch((error: unknown) => {
  getLogger("admin-api").error("admin api failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
