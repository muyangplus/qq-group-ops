import {
  findDefinition,
  findDefinitionByEnvKey,
  isEnvBacked,
  type PlatformSettingsStore,
  type SettingView,
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

/**
 * `.env` 只读项的标签（键名与 `config.ts` / `adminApi/config.ts` 保持一致）。
 *
 * ⚠️ 这里**只放真正留在 `.env` 里的核心项**（ADR-0066）：热改项一律不列 —— 它们在
 * 「可改项」那一段显示（带各自的 `envKey`），列进只读段只会让人以为「它不能改」（真机反馈）。
 */
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
  // 日志
  LOG_LEVEL: "日志级别",
  LOG_FILE: "日志文件",
  LOG_CONSOLE: "控制台日志",
  LOG_COLOR: "日志颜色",
  // `TZ` 不在这里：它既是 `.env` 的启动默认值、又是热改项（展示时区），
  // 统一在「可改项」那段显示（`envBacked` = true，来源会写「.env 默认」）。
  // 管理 API
  ADMIN_API_ENABLED: "管理 API 开关",
  ADMIN_API_HOST: "管理 API 监听地址",
  ADMIN_API_PORT: "管理 API 端口",
  ADMIN_API_PUBLIC_BASE_URL: "管理 API 公开地址",
  ADMIN_API_COOKIE_SECURE: "管理 API 安全 Cookie",
  ADMIN_API_SESSION_SECRET: "管理 API 会话密钥",
  ADMIN_API_TOKENS: "管理 API 机器令牌",
  ADMIN_API_ALLOWED_OPENIDS: "管理 API 白名单 openid",
  ADMIN_API_WEB_DIR: "管理前台静态目录",
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

/**
 * 一个可热改项（对应 `SETTING_DEFINITIONS` 里的一项）。
 *
 * ⚠️ ADR-0066 之后 `envKey` **不再代表默认值来源**：除 `envBacked` 的项外，`.env` 只在
 * 启动时导入一次，之后默认值来自代码。前端文案必须看 `envBacked`，别一律写「.env 默认」。
 */
export interface AdminApiSettingItem {
  key: string;
  /** `.env` 里的名字（历史来源键；用于说明「以前在哪配」）。 */
  envKey: string;
  label: string;
  unit: string;
  /** 生效值（原始类型），编辑框回填用。 */
  value: number | boolean | string;
  /** 给人看的一行（复用 `/config` 的 `describe`）。 */
  display: string;
  /** `env` = 用启动默认值（**除 `envBacked` 外都是代码内置值**）；`override` = 库里存了覆盖值。 */
  source: "env" | "override";
  /** 启动默认值是否真的来自 `.env`（核心项，目前只有 `TZ`）。 */
  envBacked: boolean;
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
    envBacked: isEnvBacked(view.definition),
  };
}

/**
 * `.env` 只读项：按 `ENV_LABELS` 的顺序给，值一律以「进程环境」为准（含 `.env` 载入结果）。
 *
 * **热改项不在这里重复出现**：同一个键（例如 `SCHEDULED_ANNOUNCE_ENABLED`）如果在
 * 「可改项」里已经能改，再列进只读段只会让人以为「它不能改」（真机反馈）。
 * 两层过滤都要做：`findDefinition`（键同名）与 `findDefinitionByEnvKey`
 * （`TZ` 这种「`.env` 名 ≠ 配置项键」的）。
 */
export function buildEnvItems(
  env: NodeJS.ProcessEnv = process.env,
): AdminApiEnvItem[] {
  return Object.entries(ENV_LABELS)
    .filter(
      ([key]) =>
        findDefinition(key) === undefined &&
        findDefinitionByEnvKey(key) === undefined,
    )
    .map(([key, label]) => {
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
