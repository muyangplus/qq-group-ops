export const DEFAULT_SQLITE_PATH = "data/qq-group-ops.db";
export const DEFAULT_BOT_CACHE_FILE = "data/qq-bot-cache.json";
export const DEFAULT_CLASS_INDEX_FILE = "data/class-index.json";
/**
 * 统计图片字体下载地址（`ACTIVITY_STATS_FONT_URL`）。
 *
 * 指向 Noto Sans SC 官方发布地址；系统已有中文字体（Windows 雅黑 / Linux Noto）
 * 时根本不会用到它。失败只影响统计图片（降级为文字统计卡）。
 */
export const DEFAULT_ACTIVITY_STATS_FONT_URL =
  "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf";

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
  /** 班级库索引（由 pnpm class:index 生成）；缺失时班级类入群规则退化为人工审核。 */
  classIndexFile: string;
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
  /** 私信首次交互主菜单的记录方式（dev 默认内存，正式默认入库）。 */
  menuFirstPush: MenuFirstPushMode;
  /** 待审批入群申请的有效期（天）；0 表示不自动过期（默认 7）。 */
  joinRequestTtlDays: number;
  /**
   * 活动通知每人每日上限（`ACTIVITY_NOTIFY_DAILY_LIMIT`，默认 3）。
   *
   * `0` = 不限制；非负整数。官方主动私信有「单用户每天 1000 条、单关系 20 qpm」
   * 的额度，封顶是为了避免活动集中变更时把额度打满、后续通知全部失败。
   */
  activityNotifyDailyLimit: number;
  /**
   * 活动通知的令牌桶速率（`ACTIVITY_NOTIFY_RATE_PER_SECOND`，默认 5）。
   *
   * `0` = 不限制；桶容量取 `ceil(速率)`，桶空时**等待**下一个令牌（不丢通知）。
   * 官方主动私信同样有 qps 限制，这里是推送侧自己的平滑。
   */
  activityNotifyRatePerSecond: number;
  /**
   * 活动统计图片的字体下载地址（`ACTIVITY_STATS_FONT_URL`）。
   *
   * 系统已有中文字体（Windows 雅黑 / Linux Noto CJK 等）时不会用到；
   * 找不到系统字体才下载并缓存到 `data/fonts/`（gitignored，不随包提交）。
   * 设为空字符串表示「只允许系统字体」，下载失败则统计图降级为文字统计卡。
   */
  activityStatsFontUrl: string;
}

export type MenuFirstPushMode = "memory" | "persistent";

/**
 * 解析「私信首次交互推一次主菜单」的记录方式。
 *
 * - `memory`：只记内存，重启后可以再次验证推送（`pnpm dev` 默认）；
 * - 其它/未设置：入库持久化，重启不重复（正式启动默认）。
 */
export function resolveMenuFirstPushMode(
  value: string | undefined,
): MenuFirstPushMode {
  const raw = value?.trim().toLowerCase() ?? "";
  if (raw.length === 0) {
    return "persistent";
  }
  if (raw === "memory" || raw === "mem") {
    return "memory";
  }
  if (raw === "persistent" || raw === "db" || raw === "database") {
    return "persistent";
  }
  throw new Error(`MENU_FIRST_PUSH 只支持 memory / persistent，收到：${value}`);
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

/** 非负整数（`0` 合法，用于「不限制」语义）。 */
function asNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = asInt(value, fallback);
  if (parsed < 0) {
    throw new Error(`invalid non-negative integer value: ${value}`);
  }
  return parsed;
}

/**
 * 文本配置。
 *
 * 未设置（`undefined`）用默认值；显式设成空字符串表示「按空值处理」
 * （例如 `ACTIVITY_STATS_FONT_URL=` 表示只允许系统字体、不下载）。
 */
function asText(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value.trim();
}

function splitCsv(value: string | undefined): string[] {  if (!value) {
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
    classIndexFile: env.CLASS_INDEX_FILE ?? DEFAULT_CLASS_INDEX_FILE,
    databaseUrl,
    databaseTarget: resolveDatabaseTarget(env.DATABASE_URL, env.SQLITE_PATH),
    adminUserIds: splitCsv(env.ADMIN_USER_IDS ?? env.ADMIN_QQ_IDS),
    logLevel: (env.LOG_LEVEL ?? "info").toUpperCase(),
    logFile: env.LOG_FILE ?? "logs/qq-group-ops.log",
    logConsole: asBool(env.LOG_CONSOLE, true),
    logColor: env.LOG_COLOR ?? "auto",
    rawMessageRetentionDays: asInt(env.RAW_MESSAGE_RETENTION_DAYS, 0),
    auditLogRetentionDays: asInt(env.AUDIT_LOG_RETENTION_DAYS, 180),
    menuFirstPush: resolveMenuFirstPushMode(env.MENU_FIRST_PUSH),
    joinRequestTtlDays: asInt(env.JOIN_REQUEST_TTL_DAYS, 7),
    activityNotifyDailyLimit: asNonNegativeInt(
      env.ACTIVITY_NOTIFY_DAILY_LIMIT,
      3,
    ),
    activityNotifyRatePerSecond: asNonNegativeInt(
      env.ACTIVITY_NOTIFY_RATE_PER_SECOND,
      5,
    ),
    activityStatsFontUrl: asText(
      env.ACTIVITY_STATS_FONT_URL,
      DEFAULT_ACTIVITY_STATS_FONT_URL,
    ),
  };
}

export function hasQqCredentials(settings: Settings): boolean {
  return Boolean(settings.qqBotAppId && settings.qqBotClientSecret);
}
