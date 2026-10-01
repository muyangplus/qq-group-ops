import { PlatformLevel } from "../core/enums.js";
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import type { PermissionService } from "../services/permissions.js";
import { adminLoginUrl, type AdminApiConfig } from "./config.js";

export interface AdminApiLinkServiceOptions {
  /** 令牌仓储；内存模式下没有它（此时功能视为未装配）。 */
  tokens?: AdminTokenRepository | undefined;
  config: AdminApiConfig;
  /** 权限判定（机器人进程里有；CLI 没有——能登服务器本身就是最高信任）。 */
  permissions?: PermissionService | undefined;
}

export interface AdminApiLoginIssue {
  token: string;
  /** 浏览器直接打开的登录链接；没配 `PUBLIC_BASE_URL` 时为 undefined。 */
  link?: string | undefined;
  expiresAt: Date;
  ttlMs: number;
}

/**
 * 管理 API 的登录令牌签发（E1-b）。
 *
 * 机器人进程用它响应 `/admin login`，CLI（`pnpm admin:token`）用它做应急签发；
 * 两边走**同一个服务**，所以"谁能签发""TTL 多长""链接长什么样"只有一份口径。
 */
export class AdminApiLinkService {
  private readonly tokens: AdminTokenRepository | undefined;
  private readonly config: AdminApiConfig;
  private readonly permissions: PermissionService | undefined;

  public constructor(options: AdminApiLinkServiceOptions) {
    this.tokens = options.tokens;
    this.config = options.config;
    this.permissions = options.permissions;
  }

  /** 功能是否可用：要开启管理 API，且本进程有令牌仓储（内存模式没有）。 */
  public get enabled(): boolean {
    return this.config.enabled && this.tokens !== undefined;
  }

  /**
   * 能不能签发：默认要**平台超管**（240）；配了 `ADMIN_API_ALLOWED_OPENIDS` 时还要在白名单里。
   *
   * 没有 `permissions`（CLI 场景）时**不做权限判定**——能登服务器跑命令的人本来就能改库。
   */
  public canIssue(userId: string): boolean {
    const allowed = this.config.allowedOpenIds;
    if (allowed.length > 0 && !allowed.includes(userId)) {
      return false;
    }
    if (!this.permissions) {
      return true;
    }
    return this.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin);
  }

  /** 签发一次性令牌并拼好登录链接。 */
  public async issueFor(
    userId: string,
    ttlMs: number = this.config.tokenTtlMs,
  ): Promise<AdminApiLoginIssue> {
    const tokens = this.tokens;
    if (!tokens) {
      throw new Error("管理 API 未装配令牌仓储（需要连接数据库）");
    }
    const { token, expiresAt } = await tokens.issue({ userId, ttlMs });
    const link = adminLoginUrl(this.config, token);
    return {
      token,
      ...(link !== undefined ? { link } : {}),
      expiresAt,
      ttlMs,
    };
  }
}
