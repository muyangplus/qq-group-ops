import type {
  PlatformSettingsStore,
  SettingView,
} from "../services/platformSettings.js";

/**
 * 管理后台的「配置」视图（E2-f）。
 *
 * 两条口径（用户定的）：
 * 1. **可改的只有既有的热改项**：`PlatformSettingsStore`（也就是机器人里 `/config` 用的那一套）
 *    已经负责校验 → 落库 → 立即生效，这里只是把它搬到网页上，**不新造一条配置通路**；
 * 2. `.env` 里的其余项**只读展示**，而且**密钥类绝不回传值** —— 浏览器只要知道「配没配」，
 *    把线上密钥送进网页没有任何好处（还会进浏览器缓存 / 截图）。
 *
 * 另有 `test/adminApiSettings.test.ts` 用源码扫描守住「`config.ts` 里读的每个 env 键都在这里
 * 出现过」，避免以后新增配置项时后台悄悄漏掉。
 */

/** 密钥类键名：形如 `*_SECRET` / `*_TOKEN` / `*_KEY` 的值一律不回传。 */
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|_KEY$|DSN|CREDENTIAL)/u;

/** `.env` 只读项的标签（键名与 `config.ts` / `adminApi/config.ts` 保持一致）。 */
export const ENV_LABELS: Readonly<Record<string, string>> = {
  // 机器人本体
  QQ_BOT_APP_ID: "机器人 AppID",
  QQ_BOT_CLIENT_SECRET: "机器人密钥",
  QQ_BOT_TOKEN: "机器人 Token",
  QQ_BOT_SANDBOX: "沙箱模式",
  QQ_BOT_CACHE_FILE: "机器人缓存文件",
  // 事件通道
  EVENT_MODE: "事件通道（websocket / webhook）",
  WEBHOOK_HOST: "Webhook 监听地址",
  WEBHOOK_PORT: "Webhook 端口",
  WEBHOOK_PATH: "Webhook 路径",
  WEBHOOK_SECRET: "Webhook 验签密钥",
  // 存储与数据文件
  DATABASE_URL: "数据库连接串",
  SQLITE_PATH: "SQLite 文件",
  CLASS_INDEX_FILE: "班级库文件",
  // 启动期默认超管
  ADMIN_USER_IDS: "初始超管 openid 列表",
  // 日志与时区
  LOG_LEVEL: "日志级别",
  LOG_FILE: "日志文件",
  LOG_CONSOLE: "控制台日志",
  LOG_COLOR: "日志颜色",
  TZ: "时区",
  // 管理 API
  ADMIN_API_ENABLED: "管理 API 开关",
  ADMIN_API_HOST: "管理 API 监听地址",
  ADMIN_API_PORT: "管理 API 端口",
  ADMIN_API_PUBLIC_BASE_URL: "管理 API 公开地址",
  ADMIN_API_COOKIE_SECURE: "管理 API 安全 Cookie",
  ADMIN_API_SESSION_SECRET: "管理 API 会话密钥",
  ADMIN_API_SESSION_TTL_MINUTES: "管理 API 会话有效期（分钟）",
  ADMIN_API_TOKEN_TTL_MINUTES: "管理 API 令牌有效期（分钟）",
  ADMIN_API_TOKENS: "管理 API 机器令牌",
  ADMIN_API_ALLOWED_OPENIDS: "管理 API 白名单 openid",
  ADMIN_API_RATE_LIMIT_PER_MINUTE: "管理 API 每分钟限流",
  ADMIN_API_WEB_DIR: "管理前台静态目录",
  // 周期任务 / 保留期等热改项的 `.env` 默认值（当前生效值可能已被后台或 /config 覆盖）
  AUDIT_LOG_RETENTION_DAYS: "审计日志保留（天）",
  RAW_MESSAGE_RETENTION_DAYS: "处罚原文保留（天）",
  JOIN_REQUEST_TTL_DAYS: "待审批申请有效期（天）",
  MENU_FIRST_PUSH: "首次菜单推送",
  ACTIVITY_NOTIFY_DAILY_LIMIT: "活动通知每日上限",
  ACTIVITY_NOTIFY_RATE_PER_SECOND: "活动通知每秒速率",
  ACTIVITY_STATS_FONT_URL: "活动统计字体地址",
  APPEAL_HOLD_MINUTES: "申诉超时转派（分钟）",
  SCAN_INTERVAL_MS: "统一扫描周期（毫秒）",
  AUTO_RESTART_ON_DEPLOY: "部署后自动重启",
  DEPLOY_RESTART_DELAY_MINUTES: "自动重启宽限（分钟）",
  DEPLOY_CHECK_INTERVAL_MS: "部署监测扫描间隔（毫秒）",
  DISPLAY_TIMEZONE: "展示时区覆盖",
};

/** `.env` 只读项（值可能被隐去）。 */
export interface AdminApiEnvItem {
  key: string;
  label: string;
  /** 密钥类：**不回传值**，只看「配没配」。 */
  secret: boolean;
  configured: boolean;
  /** 非敏感键的当前值；密钥类与未配置时缺省。 */
  value?: string | undefined;
}

/** 一个可热改项（对应 `SETTING_DEFINITIONS` 里的一项）。 */
export interface AdminApiSettingItem {
  key: string;
  /** `.env` 里的名字（面板上显示「默认值来自哪」）。 */
  envKey: string;
  label: string;
  unit: string;
  /** 生效值（原始类型），编辑框回填用。 */
  value: number | boolean | string;
  /** 给人看的一行（复用 `/config` 的 `describe`）。 */
  display: string;
  /** `env` = 用 `.env` 默认值；`override` = 已经被后台 / `/config` 改过（存在库里）。 */
  source: "env" | "override";
}

export interface AdminApiSettingsView {
  /** 可改的热改项（`PUT /api/settings` 能改的就是这些 key）。 */
  settings: AdminApiSettingItem[];
  /** `.env` 只读项（密钥类不回传值）。 */
  env: AdminApiEnvItem[];
  /** 启动加载时发现的问题（坏值 / 未知键），供运维排查。 */
  issues: string[];
}

/** 组装「配置」视图：可改项来自热改存储，只读项来自进程环境。 */
export function buildSettingsView(
  platform: PlatformSettingsStore,
  env: NodeJS.ProcessEnv = process.env,
): AdminApiSettingsView {
  return {
    settings: platform.list().map(toSettingItem),
    env: buildEnvItems(env),
    issues: [...platform.issues],
  };
}

/** 单项视图 → API 形状（`buildSettingsView` 与写端点返回体共用同一份换算）。 */
export function toSettingItem(view: SettingView): AdminApiSettingItem {
  return {
    key: view.definition.key,
    envKey: view.definition.envKey,
    label: view.definition.label,
    unit: view.definition.unit,
    value: view.value,
    display: view.definition.describe(view.value),
    source: view.source,
  };
}

/** `.env` 只读项：按 `ENV_LABELS` 的顺序给，值一律以「进程环境」为准（含 `.env` 载入结果）。 */
export function buildEnvItems(
  env: NodeJS.ProcessEnv = process.env,
): AdminApiEnvItem[] {
  return Object.entries(ENV_LABELS).map(([key, label]) => {
    const raw = env[key];
    const configured = raw !== undefined && raw.trim().length > 0;
    const secret = SECRET_KEY_PATTERN.test(key);
    return {
      key,
      label,
      secret,
      configured,
      ...(!secret && configured ? { value: raw } : {}),
    };
  });
}

/** 某个键是不是「密钥类」（只读展示用）。 */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}
