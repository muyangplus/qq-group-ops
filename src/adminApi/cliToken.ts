import { loadSettings } from "../config.js";
import { loadEnvFile } from "../env.js";
import { connectPersistence } from "../persistence.js";
import { loadAdminApiConfig } from "./config.js";
import { AdminApiLinkService } from "./loginLink.js";

/**
 * 应急签发管理后台登录令牌（E1-b）。
 *
 * 用途：机器人挂了 / 私信收不到 / 手上没有 QQ 客户端，但又必须进后台排查时，
 * 在**服务器终端**跑：
 *
 * ```bash
 * pnpm build && pnpm admin:token --user=<openid> [--ttl=10]
 * ```
 *
 * 为什么不做权限判定：能登服务器跑这条命令的人本来就能直接改库，比任何登录都强。
 * 用法里的 openid 用 `/whois` 查自己。
 */
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main(): Promise<void> {
  // 应急命令通常在服务器应用目录里直接跑，必须自己读 `.env`（环境变量已有的值优先）
  loadEnvFile();
  const config = loadAdminApiConfig();
  if (!config.enabled) {
    throw new Error(
      "管理 API 未开启（ADMIN_API_ENABLED）：签出来的令牌没人能兑换。",
    );
  }
  const user = argValue("user")?.trim();
  if (!user) {
    throw new Error(
      "用法：pnpm admin:token --user=<openid> [--ttl=<分钟>]（openid 用 /whois 查自己）",
    );
  }
  const ttlMinutes = Number.parseInt(argValue("ttl") ?? "", 10);
  const ttlMs =
    Number.isInteger(ttlMinutes) && ttlMinutes > 0
      ? ttlMinutes * 60_000
      : config.tokenTtlMs;

  const settings = loadSettings();
  const persistence = await connectPersistence(settings);
  if (!persistence) {
    throw new Error("需要数据库：DATABASE_URL=memory 时无法签发登录令牌。");
  }
  try {
    const service = new AdminApiLinkService({
      tokens: persistence.adminTokens,
      config,
    });
    const issued = await service.issueFor(user, ttlMs);
    console.log(
      `一次性登录令牌（${Math.round(ttlMs / 60_000)} 分钟内有效，只能用一次）：`,
    );
    console.log(issued.token);
    if (issued.link !== undefined) {
      console.log("");
      console.log("登录链接：");
      console.log(issued.link);
    } else {
      console.log("");
      console.log(
        "未配置 ADMIN_API_PUBLIC_BASE_URL：请在后台登录页粘贴上面的令牌。",
      );
    }
  } finally {
    await persistence.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `签发失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
