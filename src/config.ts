export const DEFAULT_SQLITE_PATH = "data/qq-group-ops.db";
export const DEFAULT_BOT_CACHE_FILE = "data/qq-bot-cache.json";

export type DatabaseTarget =
  | { driver: "sqlite"; path: string }
  | { driver: "postgres"; url: string }
  | { driver: "memory" };

export interface Settings {
  qqBotAppId: string;
  qqBotClientSecret: string;
  qqBotToken: string;
  qqBotSandbox: boolean;
  /** access token / 网关地址缓存文件；空字符串表示只用内存缓存。 */
  qqBotCacheFile: string;
  /** 原始 DATABASE_URL，仅用于日志与诊断。 */
  databaseUrl: string;
  /** 解析后的数据库目标；默认 SQLite 文件。 */
  databaseTarget: DatabaseTarget;
  adminUserIds: readonly string[];
  logLevel: string;
  logFile: string;
  logConsole: boolean;
  logColor: string;
  rawMessageRetentionDays: number;
  auditLogRetentionDays: number;
}

function asBool(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function asInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid integer value: ${value}`);
  }
  return parsed;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 解析数据库目标。
 *
 * - 未设置 `DATABASE_URL`：默认 SQLite 文件（可用 `SQLITE_PATH` 覆盖）；
 * - `postgres://` / `postgresql://`：PostgreSQL；
 * - `sqlite:` 前缀或普通路径：SQLite；
 * - `memory` / `:memory:`：纯内存，重启即丢。
 */
export function resolveDatabaseTarget(
  databaseUrl: string | undefined,
  sqlitePath?: string,
): DatabaseTarget {
  const raw = databaseUrl?.trim() ?? "";
  if (raw.length === 0) {
    return sqliteTarget(sqlitePath?.trim() || DEFAULT_SQLITE_PATH);
  }

  const lower = raw.toLowerCase();
  if (lower === "memory" || lower === ":memory:" || lower === "sqlite::memory:") {
    return { driver: "memory" };
  }
  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) {
    return { driver: "postgres", url: raw };
  }
  if (lower.startsWith("sqlite:")) {
    const path =
      raw.slice("sqlite:".length).replace(/^\/\//u, "") || DEFAULT_SQLITE_PATH;
    return sqliteTarget(path);
  }
  // 没有方言前缀时按 SQLite 文件路径处理，方便直接写 ./data/bot.db
  return sqliteTarget(raw);
}

function sqliteTarget(path: string): DatabaseTarget {
  return path === ":memory:" || path === "memory"
    ? { driver: "memory" }
    : { driver: "sqlite", path };
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  return {
    qqBotAppId: env.QQ_BOT_APP_ID ?? "",
    qqBotClientSecret: env.QQ_BOT_CLIENT_SECRET ?? "",
    qqBotToken: env.QQ_BOT_TOKEN ?? "",
    qqBotSandbox: asBool(env.QQ_BOT_SANDBOX),
    qqBotCacheFile: env.QQ_BOT_CACHE_FILE ?? DEFAULT_BOT_CACHE_FILE,
    databaseUrl,
    databaseTarget: resolveDatabaseTarget(env.DATABASE_URL, env.SQLITE_PATH),
    adminUserIds: splitCsv(env.ADMIN_USER_IDS ?? env.ADMIN_QQ_IDS),
    logLevel: (env.LOG_LEVEL ?? "info").toUpperCase(),
    logFile: env.LOG_FILE ?? "logs/qq-group-ops.log",
    logConsole: asBool(env.LOG_CONSOLE, true),
    logColor: env.LOG_COLOR ?? "auto",
    rawMessageRetentionDays: asInt(env.RAW_MESSAGE_RETENTION_DAYS, 0),
    auditLogRetentionDays: asInt(env.AUDIT_LOG_RETENTION_DAYS, 180),
  };
}

export function hasQqCredentials(settings: Settings): boolean {
  return Boolean(settings.qqBotAppId && settings.qqBotClientSecret);
}
