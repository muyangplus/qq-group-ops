import type { Settings } from "../config.js";
import type { PlatformSettingsRepository } from "../db/platformSettingsRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("platform-settings");

/**
 * 可热改的平台配置项（**非核心**项：核心项留在 `.env`，见 ADR-0066 与 docs/CONFIGURATION.md）。
 *
 * 每一项都对应 `Settings` 上的一个字段，因此取值仍然是类型安全的：
 * `store.get("scanIntervalMs")` 的类型就是 `number`。
 *
 * **默认值来自代码**（`Settings` 的 `loadSettings()` 只填内置默认值）：`.env` 里写了这些键
 * 只在**启动时导入库一次**（`importEnvSettingsToStore`），此后一切以库为准 —— 见 ADR-0066。
 * 唯一的例外是 `displayTimezone`（`TZ`）：日志时间在连库之前就要用，所以它仍然是
 * 「`.env` 默认 + 库覆盖」（下面 `SettingDefinition.envBacked`）。
 */
export const HOT_SETTING_KEYS = [
  "auditLogRetentionDays",
  "rawMessageRetentionDays",
  "joinRequestTtlDays",
  "menuFirstPush",
  "activityNotifyDailyLimit",
  "activityNotifyRatePerSecond",
  "appealHoldMinutes",
  "scanIntervalMs",
  "autoRestartOnDeploy",
  "deployRestartDelayMinutes",
  "deployCheckIntervalMs",
  "joinSyncIntervalMs",
  "scheduledAnnounceEnabled",
  "scheduledAnnounceHourlyLimit",
  "activityStatsFontUrl",
  "displayTimezone",
  "adminApiSessionTtlMinutes",
  "adminApiTokenTtlMinutes",
  "adminApiRateLimitPerMinute",
] as const;

export type HotSettingKey = (typeof HOT_SETTING_KEYS)[number];

export interface SettingDefinition {
  key: HotSettingKey;
  /**
   * `.env` 里的名字。
   *
   * - `envBacked` 为 true：启动默认值来自这个环境变量（面板上显示「来源」用）；
   * - 否则：它只是**一次性导入**的来源键（`.env` 里写了就在启动时导入库一次，见 ADR-0066）。
   */
  envKey: string;
  label: string;
  /** 按钮上的短名（卡片一行最多 12 个字，两列必须短）。 */
  short: string;
  unit: string;
  /**
   * 这一项的启动默认值是否仍然取自 `.env`（核心项）。
   *
   * 留空 = `false`：默认值来自代码（`loadSettings()`），`.env` 只在启动时导入一次。
   * 只有「连库之前就要用」的项才置 true（目前只有展示时区 `TZ`）。
   */
  envBacked?: boolean | undefined;
  /** 解析 + 校验一段用户输入；失败给出能直接展示的中文原因。 */
  parse(raw: string): ParsedSetting;
  /** 面板上显示当前值。 */
  describe(value: unknown): string;
}

export type ParsedSetting =
  | { ok: true; value: number | boolean | string }
  | { ok: false; error: string };

/** 整数解析：范围 + 中文错误信息。 */
function intSetting(
  key: HotSettingKey,
  envKey: string,
  label: string,
  short: string,
  unit: string,
  min: number,
  max: number,
  describe?: (value: number) => string,
): SettingDefinition {
  return {
    key,
    envKey,
    label,
    short,
    unit,
    parse: (raw) => {
      const trimmed = raw.trim();
      if (!/^-?\d+$/u.test(trimmed)) {
        return { ok: false, error: `${label}要写整数（收到：${raw}）` };
      }
      const value = Number.parseInt(trimmed, 10);
      if (value < min || value > max) {
        return {
          ok: false,
          error: `${label}要在 ${min}–${max} 之间（收到：${value}）`,
        };
      }
      return { ok: true, value };
    },
    describe: describe ?? ((value: unknown) => `${String(value)}${unit}`),
  };
}

function boolSetting(
  key: HotSettingKey,
  envKey: string,
  label: string,
  short: string,
): SettingDefinition {
  return {
    key,
    envKey,
    label,
    short,
    unit: "",
    parse: (raw) => {
      const value = raw.trim().toLowerCase();
      if (["1", "on", "true", "开", "是", "yes"].includes(value)) {
        return { ok: true, value: true };
      }
      if (["0", "off", "false", "关", "否", "no"].includes(value)) {
        return { ok: true, value: false };
      }
      return { ok: false, error: `${label}要写 开 / 关（或 on / off）` };
    },
    describe: (value: unknown) => (value === true ? "开" : "关"),
  };
}

/** 可热改项的定义（顺序即面板顺序）。 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  intSetting("auditLogRetentionDays", "AUDIT_LOG_RETENTION_DAYS", "审计日志保留", "审计保留", "天", -1, 3650, retentionLabel),
  intSetting("rawMessageRetentionDays", "RAW_MESSAGE_RETENTION_DAYS", "处罚原文保留", "原文保留", "天", -1, 365, retentionLabel),
  intSetting("joinRequestTtlDays", "JOIN_REQUEST_TTL_DAYS", "待审批申请有效期", "审批有效期", "天", -1, 365, retentionLabel),
  {
    key: "menuFirstPush",
    envKey: "MENU_FIRST_PUSH",
    label: "首次菜单推送",
    short: "首次菜单",
    unit: "",
    parse: (raw) => {
      const value = raw.trim().toLowerCase();
      // 兼容老 `.env` 里写过的别名（原 `resolveMenuFirstPushMode` 的口径），避免迁移时漂移
      if (value === "memory" || value === "mem") {
        return { ok: true, value: "memory" };
      }
      if (
        value === "persistent" ||
        value === "db" ||
        value === "database"
      ) {
        return { ok: true, value: "persistent" };
      }
      return { ok: false, error: "要写 persistent（入库去重）或 memory（只记内存）" };
    },
    describe: (value: unknown) =>
      value === "persistent" ? "persistent（入库）" : "memory（内存）",
  },
  intSetting("activityNotifyDailyLimit", "ACTIVITY_NOTIFY_DAILY_LIMIT", "活动通知每日上限", "每日上限", "条", 0, 10000),
  intSetting("activityNotifyRatePerSecond", "ACTIVITY_NOTIFY_RATE_PER_SECOND", "活动通知速率", "通知速率", "条/秒", 1, 100),
  intSetting("appealHoldMinutes", "APPEAL_HOLD_MINUTES", "申诉超时轮转", "申诉超时", "分钟", 1, 10080),
  intSetting("scanIntervalMs", "SCAN_INTERVAL_MS", "扫描周期", "扫描周期", "毫秒", 0, 3_600_000, (value) =>
    value === 0 ? "关闭所有周期任务" : `${value} 毫秒`,
  ),
  boolSetting("autoRestartOnDeploy", "AUTO_RESTART_ON_DEPLOY", "部署后自动重启", "自动重启"),
  intSetting("deployRestartDelayMinutes", "DEPLOY_RESTART_DELAY_MINUTES", "自动重启宽限", "重启宽限", "分钟", 0, 1440),
  intSetting("deployCheckIntervalMs", "DEPLOY_CHECK_INTERVAL_MS", "部署检查周期", "检查周期", "毫秒", 1000, 3_600_000),
  intSetting("joinSyncIntervalMs", "JOIN_SYNC_INTERVAL_MS", "入群申请对账周期", "申请对账", "毫秒", 0, 86_400_000, (value) =>
    value === 0 ? "关闭（只在 /sync 时对账）" : `每 ${Math.round(value / 60_000)} 分钟对一次账`,
  ),
  boolSetting("scheduledAnnounceEnabled", "SCHEDULED_ANNOUNCE_ENABLED", "定时发言总开关", "定时发言"),
  intSetting("scheduledAnnounceHourlyLimit", "SCHEDULED_ANNOUNCE_HOURLY_LIMIT", "定时发言每小时上限", "发言上限", "条", 0, 100, (value) =>
    value === 0 ? "不限制" : `每群每小时 ${value} 条`,
  ),
  {
    key: "activityStatsFontUrl",
    envKey: "ACTIVITY_STATS_FONT_URL",
    label: "统计图字体地址",
    short: "字体地址",
    unit: "",
    parse: (raw) => {
      const value = raw.trim();
      if (value === "") {
        return { ok: true, value: "" };
      }
      if (!/^https?:\/\//u.test(value)) {
        return { ok: false, error: "要写 http(s):// 开头的地址，或留空" };
      }
      return { ok: true, value };
    },
    describe: (value: unknown) => (value === "" ? "（未设置）" : String(value)),
  },
  {
    key: "displayTimezone",
    envKey: "TZ",
    label: "展示时区",
    short: "时区",
    unit: "",
    // 日志时间在连库之前就要用：这一项仍然以 `.env` 为启动默认值（见 ADR-0066）
    envBacked: true,
    parse: (raw) => {
      const value = raw.trim();
      try {
        new Intl.DateTimeFormat("zh-CN", { timeZone: value });
        return { ok: true, value };
      } catch {
        return { ok: false, error: `不是有效时区（如 Asia/Shanghai）：${value}` };
      }
    },
    describe: (value: unknown) => String(value),
  },
  intSetting(
    "adminApiSessionTtlMinutes",
    "ADMIN_API_SESSION_TTL_MINUTES",
    "管理后台会话有效期",
    "会话有效期",
    "分钟",
    1,
    10080,
    (value) =>
      value >= 1440 && value % 1440 === 0 ? `${value / 1440} 天` : `${value} 分钟`,
  ),
  intSetting(
    "adminApiTokenTtlMinutes",
    "ADMIN_API_TOKEN_TTL_MINUTES",
    "登录令牌有效期",
    "令牌有效期",
    "分钟",
    1,
    1440,
  ),
  intSetting(
    "adminApiRateLimitPerMinute",
    "ADMIN_API_RATE_LIMIT_PER_MINUTE",
    "管理后台每分钟限流",
    "后台限流",
    "次/分钟",
    0,
    100_000,
    (value) => (value === 0 ? "不限" : `每分钟 ${value} 次`),
  ),
];

/**
 * 仍然以 `.env` 为启动默认值的项（核心项：改了要重启 / 连库之前就要用）。
 *
 * 其余项一律「代码内置默认 + 库覆盖」；`.env` 里写了它们只在**启动时导入一次**。
 */
export function isEnvBacked(definition: SettingDefinition): boolean {
  return definition.envBacked === true;
}

/** 需要在启动时从 `.env` 一次性导入库的键（= 除 `envBacked` 以外的全部热改项）。 */
export const IMPORTED_FROM_ENV_KEYS: readonly HotSettingKey[] =
  SETTING_DEFINITIONS.filter((definition) => !isEnvBacked(definition)).map(
    (definition) => definition.key,
  );

function retentionLabel(value: number): string {
  if (value === -1) {
    return "永久保留";
  }
  if (value === 0) {
    return "关闭（不保留 / 不清理）";
  }
  return `${value} 天`;
}

export function definitionOf(key: HotSettingKey): SettingDefinition {
  const definition = SETTING_DEFINITIONS.find((item) => item.key === key);
  if (!definition) {
    throw new Error(`未知的可热改配置项：${key}`);
  }
  return definition;
}

export function findDefinition(key: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find((item) => item.key === key);
}

/**
 * 按 `.env` 里的名字找定义（`TZ` → `displayTimezone`）。
 *
 * 配置页据此判断「这个 `.env` 键是不是已经能在可改项里改」：是的话就别在只读段再列一遍
 * （同一个键两处出现，运维会以为不能改 —— 真机反馈过）。
 */
export function findDefinitionByEnvKey(
  envKey: string,
): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find((item) => item.envKey === envKey);
}

/**
 * 「这一项已经从 `.env` 导入过」的留痕键前缀（存在同一张 `platform_settings` 表里）。
 *
 * 为什么不看「库里有没有覆盖行」来判断「迁移做过没有」：那样 `/config clear`（删掉覆盖行）
 * 之后，下一次启动会把 `.env` 里的旧值**又导回来** —— 于是「`/config clear` 回内置默认」
 * 只在本次进程内成立，和面板文案、`.env.example` 的说法直接矛盾。留痕是**只写一次**的
 * 事实记录，`clear()` 不会动它，所以迁移真的只做一次。
 *
 * 只在「确实写库了」时留痕：坏值 / 与内置默认相同**不留痕** —— 用户把 `.env` 那一行改好之后
 * 还要能重新导入（留了痕就永远不生效了）。
 */
export const ENV_IMPORT_MARKER_PREFIX = "__env_import__:";

/**
 * 生效值的来源。
 *
 * ⚠️ `env` 是历史命名：它表示「**没被覆盖**、用的是启动默认值」。除 `envBacked` 的项以外，
 * 那个默认值来自**代码内置值**而不是当前 `.env`（`.env` 只在启动时导入一次，见 ADR-0066）——
 * 所以展示文案必须按 `definition.envBacked` 区分，别一律写「`.env` 默认」。
 */
export type SettingSource = "env" | "override";

export interface SettingView {
  definition: SettingDefinition;
  value: number | boolean | string;
  source: SettingSource;
  /** 数据库里存的原始 JSON 文本（有覆盖时才有）。 */
  raw?: string;
}

/**
 * 平台配置的**单一来源**：默认值来自代码（`Settings` 里 `loadSettings()` 填的内置默认值，
 * 除了 `displayTimezone` 这类核心项来自 `.env`），数据库覆盖优先 ——
 * 服务在**用的时候**读 `get()`，所以改完立即生效（不需要重启）。
 *
 * `.env` 里写了热改项时，启动过程会把它们**导入库一次**（`settingsImport.ts`，ADR-0066）：
 * 导入之后 `sourceOf()` 就是 `override`，`.env` 再改也不再有任何影响。
 *
 * 加载时的坏值（手改过的库 / 老版本写坏）只跳过并记进 `issues`：配置读不出来
 * 就该退回内置默认，不能让启动失败。
 */
export class PlatformSettingsStore {
  private readonly queue: WriteQueue | undefined;
  private readonly overrides = new Map<HotSettingKey, string>();
  /** 「已经从 `.env` 导入过」的留痕（见 `ENV_IMPORT_MARKER_PREFIX`）：`clear()` 不动它。 */
  private readonly importedFromEnv = new Map<HotSettingKey, string>();
  private readonly changes: Array<(key: HotSettingKey) => void> = [];
  private readonly problems: string[] = [];
  private current: Settings;

  public constructor(
    private readonly base: Settings,
    private readonly repository?: PlatformSettingsRepository,
    queue?: WriteQueue,
  ) {
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
    this.current = { ...base };
  }

  /** 有没有持久化后端（纯内存数据库 / 单测里没有）：没有时改配置只作用于本进程。 */
  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  /** 从数据库读覆盖值并算出生效值（幂等，可重复调用）。 */
  public async load(): Promise<void> {
    this.overrides.clear();
    this.importedFromEnv.clear();
    this.problems.length = 0;
    this.current = { ...this.base };
    if (!this.repository) {
      return;
    }
    for (const row of await this.repository.findAll()) {
      // 导入留痕不是配置项：不进 `list()`、不算坏值（见 ENV_IMPORT_MARKER_PREFIX）
      if (row.key.startsWith(ENV_IMPORT_MARKER_PREFIX)) {
        const marked = row.key.slice(ENV_IMPORT_MARKER_PREFIX.length);
        const definition = findDefinition(marked);
        if (definition) {
          this.importedFromEnv.set(definition.key, row.value);
        } else {
          log.warn("unknown env-import marker ignored", { key: row.key });
        }
        continue;
      }
      const definition = findDefinition(row.key);
      if (!definition) {
        this.problems.push(`未知配置项被忽略：${row.key}`);
        continue;
      }
      const parsed = parseStored(row.value, definition);
      if (!parsed.ok) {
        this.problems.push(`${definition.label}：${parsed.error}`);
        continue;
      }
      this.apply(definition.key, parsed.value);
      this.overrides.set(definition.key, row.value);
    }
    if (this.overrides.size > 0) {
      log.info("platform settings overridden", {
        keys: [...this.overrides.keys()],
      });
    }
  }

  /**
   * 这一项有没有「已经从 `.env` 导入过」的留痕。
   *
   * 导入器靠它保证**一次性**：留痕在，就说明这一项的生效值已经以库为准了 ——
   * 之后哪怕 `/config clear` 把覆盖行删掉，也不该再从 `.env` 导回来。
   */
  public wasImportedFromEnv(key: HotSettingKey): boolean {
    return this.importedFromEnv.has(key);
  }

  /**
   * 记下「这一项已经从 `.env` 导入过」（导入器在**真的写库之后**调用）。
   *
   * 纯内存模式只记在本进程；有仓储时同时落库（走同一个写队列，调用方接着 `flush()`）。
   */
  public async markImportedFromEnv(
    key: HotSettingKey,
    raw: string,
    at: Date = new Date(),
  ): Promise<void> {
    const definition = definitionOf(key);
    const value = JSON.stringify({
      envKey: definition.envKey,
      raw,
      importedAt: at.toISOString(),
    });
    this.importedFromEnv.set(key, value);
    if (this.repository) {
      const repository = this.repository;
      this.queue?.enqueue("platform-setting.import-marker", () =>
        repository.save({ key: `${ENV_IMPORT_MARKER_PREFIX}${key}`, value }),
      );
    }
  }

  /** 生效值（**用的时候读**，因此改完立即生效）。 */
  public get<K extends HotSettingKey>(key: K): Settings[K] {
    return this.current[key];
  }

  /** 生效值（键是运行时才知道的字符串时用；找不到就是无效键）。 */
  public valueOf(key: string): number | boolean | string | undefined {
    const definition = findDefinition(key);
    return definition ? this.current[definition.key] : undefined;
  }

  public sourceOf(key: HotSettingKey): SettingSource {
    return this.overrides.has(key) ? "override" : "env";
  }

  /** 加载时发现的问题（坏值 / 未知键），供 `/status proc` 与 `/config` 展示。 */
  public get issues(): readonly string[] {
    return [...this.problems];
  }

  public list(): SettingView[] {
    return SETTING_DEFINITIONS.map((definition) => {
      const raw = this.overrides.get(definition.key);
      return {
        definition,
        value: this.current[definition.key],
        source: raw === undefined ? "env" : "override",
        ...(raw !== undefined ? { raw } : {}),
      };
    });
  }

  /** 改一项（校验 → 落库 → 立即生效）；返回解析后的值或中文错误。 */
  public async set(
    key: string,
    raw: string,
  ): Promise<{ ok: true; view: SettingView } | { ok: false; error: string }> {
    const definition = findDefinition(key);
    if (!definition) {
      return { ok: false, error: `没有叫「${key}」的可改配置项` };
    }
    const parsed = definition.parse(raw);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const stored = JSON.stringify(parsed.value);
    this.overrides.set(definition.key, stored);
    this.apply(definition.key, parsed.value);
    if (this.repository) {
      const repository = this.repository;
      this.queue?.enqueue("platform-setting.save", () =>
        repository.save({ key: definition.key, value: stored }),
      );
    }
    this.notify(definition.key);
    return { ok: true, view: this.viewOf(definition.key) };
  }

  /** 恢复成启动默认值（内置默认；`displayTimezone` 这类核心项则是 `.env` 值）。 */
  public async clear(key: string): Promise<{ ok: boolean; error?: string }> {
    const definition = findDefinition(key);
    if (!definition) {
      return { ok: false, error: `没有叫「${key}」的可改配置项` };
    }
    if (!this.overrides.has(definition.key)) {
      return { ok: true };
    }
    this.overrides.delete(definition.key);
    this.apply(definition.key, this.base[definition.key]);
    if (this.repository) {
      const repository = this.repository;
      this.queue?.enqueue("platform-setting.remove", () =>
        repository.remove(definition.key),
      );
    }
    this.notify(definition.key);
    return { ok: true };
  }

  /** 注册「这一项变了」的推送回调（需要在系统里主动生效的那些项用）。 */
  public onChange(listener: (key: HotSettingKey) => void): void {
    this.changes.push(listener);
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  private viewOf(key: HotSettingKey): SettingView {
    const raw = this.overrides.get(key);
    return {
      definition: definitionOf(key),
      value: this.current[key],
      source: raw === undefined ? "env" : "override",
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  private apply(key: HotSettingKey, value: number | boolean | string): void {
    (this.current as unknown as Record<string, unknown>)[key] = value;
  }

  private notify(key: HotSettingKey): void {
    for (const listener of this.changes) {
      listener(key);
    }
  }
}

/** 解析库里存的 JSON；类型不符合定义时算坏值。 */
function parseStored(raw: string, definition: SettingDefinition): ParsedSetting {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: `库里的值不是 JSON（${raw}），已跳过` };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return definition.parse(String(value));
  }
  if (typeof value === "string") {
    return definition.parse(value);
  }
  return { ok: false, error: `库里的值类型不对（${raw}），已跳过` };
}
