/**
 * 管理 API 配置（E1-a，认证方案 B2：机器人私信一次性令牌 + 会话 cookie）。
 *
 * 这些是**核心安全项**，只从 `.env` / 环境变量读，**不进 `/config` 热配置**：
 * 会话密钥属于"改了就得重启"的东西，放到运行时可改的面板里只会给自己挖坑。
 *
 * 认证流程（见 docs/ADMIN-API.md §1）：
 * 1. 管理员私信机器人 `/admin login`（或服务器上跑 `pnpm admin:token`）→ 签发**一次性令牌**；
 * 2. 浏览器打开 `PUBLIC_BASE_URL/login?token=…`（或手工粘贴令牌）→ `POST /auth/token` 兑换；
 * 3. 服务端校验令牌（一次性 + TTL + 只存 sha256）→ 种会话 cookie（`HttpOnly` + `SameSite=Strict`）。
 *
 * 因此这里**没有账号与口令**：身份天然是 openid，权限直接复用现有两轴模型（E1-b）。
 */
export interface AdminApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** 会话 cookie 的 HMAC 密钥（≥32 字符）。 */
  sessionSecret: string;
  /** 会话滑动过期时间。 */
  sessionTtlMs: number;
  /** cookie 是否带 `Secure`（前面挂了 TLS 反代时开）。 */
  cookieSecure: boolean;
  /**
   * 浏览器能访问的管理面地址（例：`https://ops.example.com`）。
   * 用于拼登录链接；本机临时排查可以留空（那就只给"粘贴令牌"的用法）。
   */
  publicBaseUrl: string;
  /**
   * 管理前台静态资源目录（默认 `web/dist`；**显式留空 = 不由机器人托管**，交给 nginx 等）。
   *
   * 目录不存在（没构建 / 没部署前端）时自动跳过，接口行为不受影响。
   */
  webDir: string;
  /** 一次性令牌有效期（默认 10 分钟；签发后必须在这个时间内兑换）。 */
  tokenTtlMs: number;
  /** 额外白名单：留空 = 允许所有**平台超管**（240）签发令牌。 */
  allowedOpenIds: readonly string[];
  /**
   * 机器调用用的长期令牌（E1-e）：`Authorization: Bearer <token>`，
   * 与一次性登录令牌分开——它不种会话、按 `scope` 限定能干什么，给 CI / 脚本用。
   */
  machineTokens: readonly AdminApiMachineToken[];
  /** 全站限流：每个会话每分钟的请求数上限（`0` = 不限）。 */
  rateLimitPerMinute: number;
}

export interface AdminApiMachineToken {
  token: string;
  /** 允许的范围：`read` / `write` / `*`（`*` = 全部）。 */
  scopes: readonly string[];
  /** 到期时间（可选；过期即视为不可用）。 */
  expiresAt?: Date | undefined;
}

export const DEFAULT_ADMIN_API_PORT = 8787;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export function loadAdminApiConfig(env: NodeJS.ProcessEnv = process.env): AdminApiConfig {
  const enabled = parseBoolean(env.ADMIN_API_ENABLED) ?? false;
  const sessionSecret = (env.ADMIN_API_SESSION_SECRET ?? "").trim();
  const config: AdminApiConfig = {
    enabled,
    // 默认只监听本机：要对外必须显式改，并且前面应有 TLS 反代
    host: (env.ADMIN_API_HOST ?? "").trim() || "127.0.0.1",
    port: positiveInt(env.ADMIN_API_PORT, DEFAULT_ADMIN_API_PORT),
    sessionSecret,
    sessionTtlMs: positiveInt(env.ADMIN_API_SESSION_TTL_MINUTES, 720) * 60 * 1000,
    cookieSecure: parseBoolean(env.ADMIN_API_COOKIE_SECURE) ?? false,
    publicBaseUrl: (env.ADMIN_API_PUBLIC_BASE_URL ?? "").trim(),
    // `undefined`（没配过）用默认 `web/dist`；显式写成空串表示「不由机器人托管」
    webDir: env.ADMIN_API_WEB_DIR === undefined ? "web/dist" : env.ADMIN_API_WEB_DIR.trim(),
    tokenTtlMs: positiveInt(env.ADMIN_API_TOKEN_TTL_MINUTES, 10) * 60 * 1000,
    allowedOpenIds: (env.ADMIN_API_ALLOWED_OPENIDS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    machineTokens: parseMachineTokens(env.ADMIN_API_TOKENS).tokens,
    rateLimitPerMinute: nonNegativeInt(
      env.ADMIN_API_RATE_LIMIT_PER_MINUTE,
      DEFAULT_RATE_LIMIT_PER_MINUTE,
    ),
  };

  if (!enabled) {
    return config;
  }
  const problems: string[] = [];
  if (sessionSecret.length < 32) {
    problems.push(
      "ADMIN_API_SESSION_SECRET 至少 32 个字符（生成：`node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"`）",
    );
  }
  problems.push(...parseMachineTokens(env.ADMIN_API_TOKENS).issues);
  if (problems.length > 0) {
    // fail-closed：配置坏了就不启动管理 API，而不是带着半套凭据跑
    throw new Error(`管理 API 配置有问题：\n- ${problems.join("\n- ")}`);
  }
  return config;
}

export interface MachineTokensParseResult {
  tokens: AdminApiMachineToken[];
  issues: string[];
}

/**
 * 解析 `ADMIN_API_TOKENS`：`token:scope1|scope2[:到期ISO时间]`，多个令牌用 `,` 分隔。
 *
 * 例：`ADMIN_API_TOKENS=abcdef0123456789:read,abcdef9876543210:read|write:2027-01-01T00:00:00Z`
 * 令牌长度下限 16（防止有人填个 `test` 就当凭据用）。
 */
export function parseMachineTokens(
  value: string | undefined,
): MachineTokensParseResult {
  const tokens: AdminApiMachineToken[] = [];
  const issues: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) {
      continue;
    }
    // 只用前两个冒号切分：到期时间是 ISO 时间（自身含冒号），不能按 `:` 全切
    const firstSep = entry.indexOf(":");
    const secondSep = firstSep < 0 ? -1 : entry.indexOf(":", firstSep + 1);
    const token = (firstSep < 0 ? entry : entry.slice(0, firstSep)).trim();
    const scopeRaw =
      firstSep < 0
        ? ""
        : secondSep < 0
          ? entry.slice(firstSep + 1)
          : entry.slice(firstSep + 1, secondSep);
    const expiryRaw = secondSep < 0 ? "" : entry.slice(secondSep + 1).trim();
    const scopes = scopeRaw
      .split("|")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
    const label = `${token.slice(0, 4)}…`;
    if (token.length < 16) {
      issues.push(`机器令牌太短（至少 16 字符）：${label}`);
      continue;
    }
    if (scopes.length === 0) {
      issues.push(`机器令牌缺少 scope（read / write / *）：${label}`);
      continue;
    }
    let expiresAt: Date | undefined;
    if (expiryRaw.length > 0) {
      const parsed = new Date(expiryRaw);
      if (Number.isNaN(parsed.getTime())) {
        issues.push(`机器令牌的到期时间不是合法 ISO 时间：${expiryRaw}`);
        continue;
      }
      expiresAt = parsed;
    }
    tokens.push({
      token,
      scopes,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  }
  return { tokens, issues };
}

/** 机器令牌是否允许某个 scope（`*` 通配）；过期即不可用。 */
export function machineTokenAllows(
  token: AdminApiMachineToken,
  scope: "read" | "write",
  now: Date = new Date(),
): boolean {
  if (token.expiresAt !== undefined && token.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  return token.scopes.includes("*") || token.scopes.includes(scope);
}

/** 登录链接（`PUBLIC_BASE_URL` 没配时返回 undefined，调用方只给令牌）。 */export function adminLoginUrl(config: AdminApiConfig, token: string): string | undefined {
  if (config.publicBaseUrl.length === 0) {
    return undefined;
  }
  return `${config.publicBaseUrl.replace(/\/+$/u, "")}/login?token=${encodeURIComponent(token)}`;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no", ""].includes(normalized)) {
    return false;
  }
  return undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
