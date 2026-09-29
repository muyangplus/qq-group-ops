import type { Settings } from "../config.js";
import type { PlatformSettingsRepository } from "../db/platformSettingsRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("platform-settings");

/**
 * 可热改的平台配置项（**非核心**项：核心项留在 `.env`，见 ADR 与 docs/CONFIGURATION.md）。
 *
 * 每一项都对应 `Settings` 上的一个字段，因此取值仍然是类型安全的：
 * `store.get("scanIntervalMs")` 的类型就是 `number`。
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
  "activityStatsFontUrl",
  "displayTimezone",
] as const;

export type HotSettingKey = (typeof HOT_SETTING_KEYS)[number];

export interface SettingDefinition {
  key: HotSettingKey;
  /** `.env` 里的名字（面板上显示「来源」用）。 */
  envKey: string;
  label: string;
  unit: string;
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
  unit: string,
  min: number,
  max: number,
  describe?: (value: number) => string,
): SettingDefinition {
  return {
    key,
    envKey,
    label,
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
): SettingDefinition {
  return {
    key,
    envKey,
    label,
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
  intSetting("auditLogRetentionDays", "AUDIT_LOG_RETENTION_DAYS", "审计日志保留", "天", -1, 3650, retentionLabel),
  intSetting("rawMessageRetentionDays", "RAW_MESSAGE_RETENTION_DAYS", "处罚原文保留", "天", -1, 365, retentionLabel),
  intSetting("joinRequestTtlDays", "JOIN_REQUEST_TTL_DAYS", "待审批申请有效期", "天", -1, 365, retentionLabel),
  {
    key: "menuFirstPush",
    envKey: "MENU_FIRST_PUSH",
    label: "首次菜单推送",
    unit: "",
    parse: (raw) => {
      const value = raw.trim().toLowerCase();
      if (value === "persistent" || value === "memory") {
        return { ok: true, value };
      }
      return { ok: false, error: "要写 persistent（入库去重）或 memory（只记内存）" };
    },
    describe: (value: unknown) =>
      value === "persistent" ? "persistent（入库）" : "memory（内存）",
  },
  intSetting("activityNotifyDailyLimit", "ACTIVITY_NOTIFY_DAILY_LIMIT", "活动通知每日上限", "条", 0, 10000),
  intSetting("activityNotifyRatePerSecond", "ACTIVITY_NOTIFY_RATE_PER_SECOND", "活动通知速率", "条/秒", 1, 100),
  intSetting("appealHoldMinutes", "APPEAL_HOLD_MINUTES", "申诉超时轮转", "分钟", 1, 10080),
  intSetting("scanIntervalMs", "SCAN_INTERVAL_MS", "扫描周期", "毫秒", 0, 3_600_000, (value) =>
    value === 0 ? "关闭所有周期任务" : `${value} 毫秒`,
  ),
  boolSetting("autoRestartOnDeploy", "AUTO_RESTART_ON_DEPLOY", "部署后自动重启"),
  intSetting("deployRestartDelayMinutes", "DEPLOY_RESTART_DELAY_MINUTES", "自动重启宽限", "分钟", 0, 1440),
  intSetting("deployCheckIntervalMs", "DEPLOY_CHECK_INTERVAL_MS", "部署检查周期", "毫秒", 1000, 3_600_000),
  {
    key: "activityStatsFontUrl",
    envKey: "ACTIVITY_STATS_FONT_URL",
    label: "统计图字体地址",
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
    unit: "",
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
];

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

export type SettingSource = "env" | "override";

export interface SettingView {
  definition: SettingDefinition;
  value: number | boolean | string;
  source: SettingSource;
  /** 数据库里存的原始 JSON 文本（有覆盖时才有）。 */
  raw?: string;
}

/**
 * 平台配置的**单一来源**：`.env` 提供默认值，数据库覆盖优先 ——
 * 服务在**用的时候**读 `get()`，所以改完立即生效（不需要重启）。
 *
 * 加载时的坏值（手改过的库 / 老版本写坏）只跳过并记进 `issues`：配置读不出来
 * 就该退回 `.env` 默认，不能让启动失败。
 */
export class PlatformSettingsStore {
  private readonly queue: WriteQueue | undefined;
  private readonly overrides = new Map<HotSettingKey, string>();
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

  /** 从数据库读覆盖值并算出生效值（幂等，可重复调用）。 */
  public async load(): Promise<void> {
    this.overrides.clear();
    this.problems.length = 0;
    this.current = { ...this.base };
    if (!this.repository) {
      return;
    }
    for (const row of await this.repository.findAll()) {
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

  /** 恢复成 `.env` 默认值（只有当前确实是覆盖态才动库）。 */
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
