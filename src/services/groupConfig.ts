import type { GroupConfigRepository } from "../db/groupConfigRepository.js";
import type { GroupSettingsRepository } from "../db/groupSettingsRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import {
  JoinDecisionMode,
  KeywordPunish,
  type JoinDecisionMode as JoinDecisionModeType,
  type KeywordPunish as KeywordPunishType,
} from "../core/enums.js";

export interface GroupConfig {
  groupId: string;
  enabled?: boolean;
  joinAuditEnabled?: boolean;
  autoApproveJoin?: boolean;
  keywords?: readonly string[];
  wordFilterEnabled?: boolean;
  exportEnabled?: boolean;
  rawMessageRetentionDays?: number;
  muteDurationSeconds?: number;
  warningMessage?: string;
  /** 命中关键词是否撤回消息。 */
  keywordRecall?: boolean;
  /** 命中关键词后的处罚动作。 */
  keywordPunish?: KeywordPunishType;
  /** 入群申请的决策模式。 */
  joinDecision?: JoinDecisionModeType;
  /** 入群答案是否必须包含班级库中的班级。 */
  joinRequireClass?: boolean;
  /** 入群答案是否必须包含姓名。 */
  joinRequireName?: boolean;
  /** 入群答案必须匹配的额外正则。 */
  joinAnswerPattern?: string;
  /** 需要人工审核时是否给出审核意见。 */
  joinReviewOpinion?: boolean;
  /** 机器人自动通过/拒绝的申请是否也推送给审核员（默认只推需要人工处理的）。 */
  notifyAutoApproved?: boolean;
  /** 入群白名单学院（空 = 不限）；由规则子卡从班级库点选。 */
  allowColleges?: readonly string[];
  /** 入群黑名单学院（优先于白名单）。 */
  denyColleges?: readonly string[];
  /** 入群白名单年级（两位，如 22；空 = 不限）。 */
  allowYears?: readonly string[];
  /** 入群黑名单年级（两位）。 */
  denyYears?: readonly string[];
}

export interface EffectiveGroupConfig {
  groupId: string;
  enabled: boolean;
  joinAuditEnabled: boolean;
  autoApproveJoin: boolean;
  keywords: readonly string[];
  wordFilterEnabled: boolean;
  exportEnabled: boolean;
  rawMessageRetentionDays: number;
  muteDurationSeconds: number;
  warningMessage: string;
  keywordRecall: boolean;
  keywordPunish: KeywordPunishType;
  joinDecision: JoinDecisionModeType;
  joinRequireClass: boolean;
  joinRequireName: boolean;
  joinAnswerPattern: string;
  joinReviewOpinion: boolean;
  notifyAutoApproved: boolean;
  allowColleges: readonly string[];
  denyColleges: readonly string[];
  allowYears: readonly string[];
  denyYears: readonly string[];
}

export type GroupConfigOverride = GroupConfig;

/** 全局默认配置使用的保留 group id。 */
export const DEFAULT_GROUP_ID = "__default__";

/** 存在 `group_configs` 里的字段（写入时是整行快照）。 */
const SQL_FIELDS = [
  "enabled",
  "joinAuditEnabled",
  "autoApproveJoin",
  "keywords",
  "wordFilterEnabled",
  "exportEnabled",
  "rawMessageRetentionDays",
  "muteDurationSeconds",
  "warningMessage",
] as const satisfies readonly (keyof GroupConfigOverride)[];

/** 存在 `group_settings` 键值表里的扩展字段（可以随时新增，不需要迁移）。 */
export const SETTING_FIELDS = [
  "keywordRecall",
  "keywordPunish",
  "joinDecision",
  "joinRequireClass",
  "joinRequireName",
  "joinAnswerPattern",
  "joinReviewOpinion",
  "notifyAutoApproved",
  "allowColleges",
  "denyColleges",
  "allowYears",
  "denyYears",
] as const satisfies readonly (keyof GroupConfigOverride)[];

export type GroupSettingKey = (typeof SETTING_FIELDS)[number];

/**
 * 所有会真正写入数据库的配置字段（`group_configs` 列 + `group_settings` 键值）。
 *
 * 新增规则字段时必须加进 `SQL_FIELDS` 或 `SETTING_FIELDS`，否则只会留在内存里；
 * `test/groupConfig.test.ts` 会用这份清单校验「配置字段 = 可持久化字段」。
 */
export const PERSISTED_CONFIG_FIELDS = [
  ...SQL_FIELDS,
  ...SETTING_FIELDS,
] as const satisfies readonly (keyof GroupConfigOverride)[];

export type PersistedConfigField = (typeof PERSISTED_CONFIG_FIELDS)[number];

const DEFAULT_CONFIG: EffectiveGroupConfig = {
  groupId: DEFAULT_GROUP_ID,
  enabled: true,
  joinAuditEnabled: true,
  autoApproveJoin: false,
  keywords: [],
  wordFilterEnabled: true,
  exportEnabled: false,
  rawMessageRetentionDays: 0,
  muteDurationSeconds: 600,
  warningMessage: "请遵守群规，不要发送违规内容。",
  keywordRecall: false,
  keywordPunish: KeywordPunish.None,
  joinDecision: JoinDecisionMode.Manual,
  joinRequireClass: false,
  joinRequireName: false,
  joinAnswerPattern: "",
  joinReviewOpinion: true,
  notifyAutoApproved: false,
  allowColleges: [],
  denyColleges: [],
  allowYears: [],
  denyYears: [],
};

export class GroupConfigStore {
  /** 构造函数（或内置默认值）提供的初始配置，用于 reset 与 reload 的基准。 */
  private readonly builtinConfig: EffectiveGroupConfig;
  /** 构造函数提供的「种子默认」（builtin + 构造函数显式项），全局清字段时回落到这里。 */
  private readonly seedDefault: EffectiveGroupConfig;
  /** 种子默认里被构造函数显式指定的字段（清持久化覆盖后仍算「显式」，不显示成继承）。 */
  private readonly seedFields: ReadonlySet<keyof GroupConfigOverride>;
  /** 当前生效的全局默认配置：builtin + 持久化的全局覆盖。 */
  private defaultConfig: EffectiveGroupConfig;
  private readonly overrides = new Map<string, GroupConfigOverride>();
  /** 每个群**显式覆盖**过的字段（含关键词，值等于默认值也算覆盖），用于「恢复本页继承」。 */
  private readonly overridden = new Map<
    string,
    Set<keyof GroupConfigOverride>
  >();
  /** 全局默认规则里**显式覆盖**过的字段（其余回落 builtinDefault）。 */
  private readonly overriddenDefault = new Set<keyof GroupConfigOverride>();
  private readonly repository: GroupConfigRepository | undefined;
  private readonly settingsRepository: GroupSettingsRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(
    defaultConfig: GroupConfig = { groupId: DEFAULT_GROUP_ID },
    repository?: GroupConfigRepository,
    queue?: WriteQueue,
    settingsRepository?: GroupSettingsRepository,
  ) {
    this.builtinConfig = {
      ...DEFAULT_CONFIG,
      ...defaultConfig,
      groupId: DEFAULT_GROUP_ID,
      keywords: normalizeKeywords(
        defaultConfig.keywords ?? DEFAULT_CONFIG.keywords,
      ),
      allowColleges: normalizeKeywords(
        defaultConfig.allowColleges ?? DEFAULT_CONFIG.allowColleges,
      ),
      denyColleges: normalizeKeywords(
        defaultConfig.denyColleges ?? DEFAULT_CONFIG.denyColleges,
      ),
      allowYears: normalizeKeywords(
        defaultConfig.allowYears ?? DEFAULT_CONFIG.allowYears,
      ),
      denyYears: normalizeKeywords(
        defaultConfig.denyYears ?? DEFAULT_CONFIG.denyYears,
      ),
    };
    this.defaultConfig = cloneConfig(this.builtinConfig);
    this.seedDefault = cloneConfig(this.builtinConfig);
    // 构造函数传入的默认值等价于「显式配置的种子默认」
    this.seedFields = new Set(overriddenFieldsOf(defaultConfig));
    this.overriddenDefault = new Set(this.seedFields);
    this.repository = repository;
    this.settingsRepository = settingsRepository;
    this.queue =
      repository || settingsRepository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined || this.settingsRepository !== undefined;
  }

  /**
   * 从数据库载入配置。
   *
   * - `group_configs`：`__default__` 行代表全局规则，其余行是单群覆盖；
   * - `group_settings`：扩展键值，`__default__` 同样代表全局。
   */
  public async load(): Promise<void> {
    if (!this.repository && !this.settingsRepository) {
      return;
    }
    this.overrides.clear();
    this.overridden.clear();
    this.defaultConfig = cloneConfig(this.seedDefault);
    this.overriddenDefault.clear();

    if (this.repository) {
      const overrides = await this.repository.findAll();
      for (const override of overrides) {
        this.applyLoadedOverride(override);
      }
    }
    if (this.settingsRepository) {
      const settings = await this.settingsRepository.findAll();
      for (const setting of settings) {
        const parsed = parseSettingValue(setting.value);
        if (parsed === undefined) {
          continue;
        }
        const patch: GroupConfigOverride = { groupId: setting.groupId };
        if (!applySettingField(patch, setting.key, parsed)) {
          continue;
        }
        this.applyLoadedOverride(patch);
      }
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  /** 当前生效的全局默认配置。 */
  public get default(): EffectiveGroupConfig {
    return cloneConfig(this.defaultConfig);
  }

  /** 内置初始配置（不含持久化的全局覆盖），用于重置全局规则。 */
  public get builtinDefault(): EffectiveGroupConfig {
    return cloneConfig(this.builtinConfig);
  }

  public get(groupId: string): EffectiveGroupConfig {
    const override = this.overrides.get(groupId);
    if (!override) {
      return { ...this.defaultConfig, groupId };
    }
    return {
      groupId,
      enabled: override.enabled ?? this.defaultConfig.enabled,
      joinAuditEnabled: override.joinAuditEnabled ?? this.defaultConfig.joinAuditEnabled,
      autoApproveJoin: override.autoApproveJoin ?? this.defaultConfig.autoApproveJoin,
      keywords: override.keywords ?? this.defaultConfig.keywords,
      wordFilterEnabled: override.wordFilterEnabled ?? this.defaultConfig.wordFilterEnabled,
      exportEnabled: override.exportEnabled ?? this.defaultConfig.exportEnabled,
      rawMessageRetentionDays:
        override.rawMessageRetentionDays ?? this.defaultConfig.rawMessageRetentionDays,
      muteDurationSeconds:
        override.muteDurationSeconds ?? this.defaultConfig.muteDurationSeconds,
      warningMessage: override.warningMessage ?? this.defaultConfig.warningMessage,
      keywordRecall: override.keywordRecall ?? this.defaultConfig.keywordRecall,
      keywordPunish: override.keywordPunish ?? this.defaultConfig.keywordPunish,
      joinDecision: override.joinDecision ?? this.defaultConfig.joinDecision,
      joinRequireClass:
        override.joinRequireClass ?? this.defaultConfig.joinRequireClass,
      joinRequireName:
        override.joinRequireName ?? this.defaultConfig.joinRequireName,
      joinAnswerPattern:
        override.joinAnswerPattern ?? this.defaultConfig.joinAnswerPattern,
      joinReviewOpinion:
        override.joinReviewOpinion ?? this.defaultConfig.joinReviewOpinion,
      notifyAutoApproved:
        override.notifyAutoApproved ?? this.defaultConfig.notifyAutoApproved,
      allowColleges: override.allowColleges ?? this.defaultConfig.allowColleges,
      denyColleges: override.denyColleges ?? this.defaultConfig.denyColleges,
      allowYears: override.allowYears ?? this.defaultConfig.allowYears,
      denyYears: override.denyYears ?? this.defaultConfig.denyYears,
    };
  }

  /**
   * 局部更新配置。
   *
   * - `groupId` 为普通群时更新单群覆盖，会与已有覆盖合并，
   *   因此 `/rules set keywords ...` 之后的 `/rules set autoApprove on` 不会把关键词重置掉；
   * - `groupId` 为 `__default__` 时更新**全局默认规则**，影响所有未单独覆盖该字段的群。
   */
  public setOverride(override: GroupConfigOverride): void {
    if (override.groupId === DEFAULT_GROUP_ID) {
      this.setDefaultOverride(override);
      return;
    }
    const existing = this.overrides.get(override.groupId);
    const merged = normalizeOverride({
      ...existing,
      ...override,
      groupId: override.groupId,
    });
    this.overrides.set(override.groupId, merged);
    const overridden = this.overriddenSet(override.groupId);
    for (const field of overriddenFieldsOf(override)) {
      overridden.add(field);
    }
    this.persistGroupOverride(override.groupId, merged, override);
  }

  /** 全局规则：整行快照 + 扩展键值。 */
  private setDefaultOverride(override: GroupConfigOverride): void {
    const normalized: GroupConfigOverride = {
      ...normalizeOverride(override),
      groupId: DEFAULT_GROUP_ID,
    };
    this.defaultConfig = {
      ...this.defaultConfig,
      ...slimOverride(normalized),
    } as EffectiveGroupConfig;
    const repository = this.repository;
    if (repository) {
      const snapshot: GroupConfigOverride = {
        ...this.defaultConfig,
        groupId: DEFAULT_GROUP_ID,
      };
      this.queue?.enqueue("group-config.default.save", () =>
        repository.saveOverride(snapshot),
      );
      if (normalized.keywords !== undefined) {
        const keywords = [...this.defaultConfig.keywords];
        this.queue?.enqueue("group-config.default.keywords", () =>
          repository.replaceKeywords(DEFAULT_GROUP_ID, keywords),
        );
      }
    }
    for (const field of overriddenFieldsOf(normalized)) {
      this.overriddenDefault.add(field);
    }
    this.persistSettings(DEFAULT_GROUP_ID, override);
  }

  /**
   * 单群持久化。
   *
   * 只有本次真的改了 SQL 字段时才写 `group_configs`，否则整行快照会把
   * 之前设置过的列清成 NULL；扩展字段单独写 `group_settings`。
   */
  private persistGroupOverride(
    groupId: string,
    merged: GroupConfigOverride,
    incoming: GroupConfigOverride,
  ): void {
    const repository = this.repository;
    if (repository && hasAnyField(incoming, SQL_FIELDS)) {
      this.queue?.enqueue("group-config.save", () =>
        repository.saveOverride(merged),
      );
      if (incoming.keywords !== undefined) {
        const keywords = [...(merged.keywords ?? [])];
        this.queue?.enqueue("group-config.keywords", () =>
          repository.replaceKeywords(groupId, keywords),
        );
      }
    }
    this.persistSettings(groupId, incoming);
  }

  private persistSettings(groupId: string, incoming: GroupConfigOverride): void {
    const settingsRepository = this.settingsRepository;
    if (!settingsRepository) {
      return;
    }
    for (const key of SETTING_FIELDS) {
      const value = incoming[key];
      if (value === undefined) {
        continue;
      }
      this.queue?.enqueue("group-config.setting", () =>
        settingsRepository.save({
          groupId,
          key,
          value: JSON.stringify(value),
        }),
      );
    }
  }

  private applyLoadedOverride(override: GroupConfigOverride): void {
    const fields = overriddenFieldsOf(override);
    if (override.groupId === DEFAULT_GROUP_ID) {
      this.defaultConfig = mergeIntoDefault(
        this.defaultConfig,
        normalizeOverride(override),
      );
      for (const field of fields) {
        this.overriddenDefault.add(field);
      }
      return;
    }
    const existing = this.overrides.get(override.groupId);
    this.overrides.set(
      override.groupId,
      normalizeOverride({ ...existing, ...override, groupId: override.groupId }),
    );
    const overridden = this.overriddenSet(override.groupId);
    for (const field of fields) {
      overridden.add(field);
    }
  }

  /** 该群**显式覆盖**过的字段（含 `__default__`）；只读快照。 */
  public overriddenFields(groupId: string): Set<keyof GroupConfigOverride> {
    if (groupId === DEFAULT_GROUP_ID) {
      return new Set(this.overriddenDefault);
    }
    return new Set(this.overridden.get(groupId) ?? []);
  }

  /**
   * 清除字段级覆盖，回落到继承：
   *
   * - `group_configs` 里对应列置 `NULL`（只清列，不动其它列）；
   * - `group_settings` 里对应 KV 行删除；
   * - `__default__` 清字段 → 回落到 `builtinDefault`（种子默认）。
   *
   * 与 `removeOverride`（整群重置）不同，这里只动指定字段，其余覆盖保持不变。
   */
  public clearFields(
    groupId: string,
    fields: readonly (keyof GroupConfigOverride)[],
  ): void {
    const targets = new Set(fields);
    if (targets.size === 0) {
      return;
    }
    const sqlTargets = SQL_FIELDS.filter((field) => targets.has(field));
    const settingTargets = SETTING_FIELDS.filter((field) => targets.has(field));

    if (groupId === DEFAULT_GROUP_ID) {
      // 全局：指定字段回落种子默认（构造函数显式项 + DEFAULT_CONFIG），其它全局覆盖保持不变。
      this.defaultConfig = {
        ...mergeIntoDefault(this.seedDefault, slimOverride(this.defaultConfig)),
        ...fieldsFromConfig(this.seedDefault, sqlTargets),
        groupId: DEFAULT_GROUP_ID,
      } as EffectiveGroupConfig;
      this.overriddenDefault.clear();
      for (const field of this.seedFields) {
        this.overriddenDefault.add(field);
      }
      for (const field of targets) {
        this.overriddenDefault.delete(field);
      }
      const repository = this.repository;
      if (repository && sqlTargets.length > 0) {
        this.queue?.enqueue("group-config.default.save", () =>
          repository.saveOverride({
            ...this.defaultConfig,
            groupId: DEFAULT_GROUP_ID,
          }),
        );
        if (targets.has("keywords")) {
          this.queue?.enqueue("group-config.default.keywords", () =>
            repository.replaceKeywords(DEFAULT_GROUP_ID, [
              ...this.seedDefault.keywords,
            ]),
          );
        }
      }
      this.removeSettings(DEFAULT_GROUP_ID, settingTargets);
      return;
    }

    const override = this.overrides.get(groupId);
    const remaining: GroupConfigOverride = { ...override, groupId };
    for (const field of targets) {
      delete remaining[field];
    }
    this.overrides.set(groupId, remaining);
    const overridden = this.overriddenSet(groupId);
    for (const field of targets) {
      overridden.delete(field);
    }
    const repository = this.repository;
    if (repository && sqlTargets.some((field) => field !== "keywords")) {
      this.queue?.enqueue("group-config.clear", () =>
        repository.clearColumns(groupId, sqlTargets),
      );
    }
    if (repository && targets.has("keywords")) {
      this.queue?.enqueue("group-config.keywords", () =>
        repository.replaceKeywords(groupId, []),
      );
    }
    this.removeSettings(groupId, settingTargets);
  }

  /** 覆盖率总览：每个有显式覆盖的群 + 覆盖字段。 */
  public listOverrideSummaries(): Array<{
    groupId: string;
    fields: Array<keyof GroupConfigOverride>;
  }> {
    const summaries: Array<{
      groupId: string;
      fields: Array<keyof GroupConfigOverride>;
    }> = [];
    for (const groupId of [...this.overridden.keys()].sort()) {
      if (groupId === DEFAULT_GROUP_ID) {
        continue;
      }
      const fields = [...this.overriddenFields(groupId)].sort(
        (a, b) => PERSISTED_FIELD_ORDER.indexOf(a) - PERSISTED_FIELD_ORDER.indexOf(b),
      );
      if (fields.length > 0) {
        summaries.push({ groupId, fields });
      }
    }
    return summaries;
  }

  private overriddenSet(groupId: string): Set<keyof GroupConfigOverride> {
    const existing = this.overridden.get(groupId);
    if (existing) {
      return existing;
    }
    const created = new Set<keyof GroupConfigOverride>();
    this.overridden.set(groupId, created);
    return created;
  }

  private removeSettings(
    groupId: string,
    fields: readonly GroupSettingKey[],
  ): void {
    const settingsRepository = this.settingsRepository;
    if (!settingsRepository || fields.length === 0) {
      return;
    }
    for (const key of fields) {
      this.queue?.enqueue("group-config.setting.delete", () =>
        settingsRepository.remove(groupId, key),
      );
    }
  }

  /**
   * 移除覆盖：单群回落到全局默认；`__default__` 回落到内置初始配置。
   */
  public removeOverride(groupId: string): void {
    if (groupId === DEFAULT_GROUP_ID) {
      this.defaultConfig = cloneConfig(this.seedDefault);
      this.overriddenDefault.clear();
    }
    this.overrides.delete(groupId);
    this.overridden.delete(groupId);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("group-config.delete", () => repository.deleteOverride(groupId));
      this.queue?.enqueue("group-config.keywords", () =>
        repository.replaceKeywords(groupId, []),
      );
    }
    const settingsRepository = this.settingsRepository;
    if (settingsRepository) {
      this.queue?.enqueue("group-config.settings.delete", () =>
        settingsRepository.removeAll(groupId),
      );
    }
  }

  public listOverrides(): GroupConfigOverride[] {
    return [...this.overrides.values()].map((override) => ({ ...override }));
  }
}

/** 关键词去重、去空白并排序，保证内存态与数据库载入态顺序一致。 */
function normalizeKeywords(keywords: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }
  return [...unique].sort();
}

function normalizeOverride(override: GroupConfigOverride): GroupConfigOverride {
  return {
    ...override,
    ...(override.keywords !== undefined
      ? { keywords: normalizeKeywords(override.keywords) }
      : {}),
    ...(override.allowColleges !== undefined
      ? { allowColleges: normalizeKeywords(override.allowColleges) }
      : {}),
    ...(override.denyColleges !== undefined
      ? { denyColleges: normalizeKeywords(override.denyColleges) }
      : {}),
    ...(override.allowYears !== undefined
      ? { allowYears: normalizeKeywords(override.allowYears) }
      : {}),
    ...(override.denyYears !== undefined
      ? { denyYears: normalizeKeywords(override.denyYears) }
      : {}),
  };
}

/** 抽出只包含「已显式设置」字段的对象（用于合并进 EffectiveGroupConfig）。 */
function slimOverride(override: GroupConfigOverride): GroupConfigOverride {
  const result: GroupConfigOverride = { groupId: override.groupId };
  for (const field of PERSISTED_CONFIG_FIELDS) {
    if (override[field] !== undefined) {
      // 逐字段拷贝：字段类型各不相同，这里以 keyof 索引赋值
      (result as unknown as Record<string, unknown>)[field] = override[field];
    }
  }
  return result;
}

/** 取配置对象里显式设置过的字段（`undefined` 视为未设置）。 */
function overriddenFieldsOf(
  override: GroupConfigOverride,
): Array<keyof GroupConfigOverride> {
  return PERSISTED_CONFIG_FIELDS.filter(
    (field) => override[field] !== undefined,
  );
}

/** 从种子默认配置里摘出指定字段（全局「恢复本页继承」回落用）。 */
function fieldsFromConfig(
  config: EffectiveGroupConfig,
  fields: readonly (keyof GroupConfigOverride)[],
): GroupConfigOverride {
  const result: GroupConfigOverride = { groupId: DEFAULT_GROUP_ID };
  for (const field of fields) {
    (result as unknown as Record<string, unknown>)[field] = config[field];
  }
  return result;
}

/** 覆盖率总览里字段的展示顺序：按持久化清单（SQL 在前、扩展在后）。 */
const PERSISTED_FIELD_ORDER: readonly (keyof GroupConfigOverride)[] =
  PERSISTED_CONFIG_FIELDS;

function cloneConfig(config: EffectiveGroupConfig): EffectiveGroupConfig {
  return {
    ...config,
    keywords: [...config.keywords],
    allowColleges: [...config.allowColleges],
    denyColleges: [...config.denyColleges],
    allowYears: [...config.allowYears],
    denyYears: [...config.denyYears],
  };
}

/** 把局部覆盖合并到全局默认配置上。 */
function mergeIntoDefault(
  base: EffectiveGroupConfig,
  override: GroupConfigOverride,
): EffectiveGroupConfig {
  return {
    ...base,
    ...slimOverride(override),
    groupId: DEFAULT_GROUP_ID,
    keywords:
      override.keywords !== undefined
        ? normalizeKeywords(override.keywords)
        : base.keywords,
  };
}

/** 本次覆盖里是否包含任一指定字段。 */
function hasAnyField(
  override: GroupConfigOverride,
  fields: readonly (keyof GroupConfigOverride)[],
): boolean {
  return fields.some((field) => override[field] !== undefined);
}

function parseSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // 兼容早期直接写入的裸字符串
    return raw;
  }
}

/** 把 `group_settings` 里的一行写成类型安全的覆盖字段。 */
function applySettingField(
  target: GroupConfigOverride,
  key: string,
  value: unknown,
): boolean {
  switch (key) {
    case "keywordRecall":
    case "joinRequireClass":
    case "joinRequireName":
    case "joinReviewOpinion":
    case "notifyAutoApproved": {
      if (typeof value !== "boolean") {
        return false;
      }
      target[key] = value;
      return true;
    }
    case "keywordPunish": {
      if (!isKeywordPunish(value)) {
        return false;
      }
      target.keywordPunish = value;
      return true;
    }
    case "joinDecision": {
      if (!isJoinDecisionMode(value)) {
        return false;
      }
      target.joinDecision = value;
      return true;
    }
    case "joinAnswerPattern": {
      if (typeof value !== "string") {
        return false;
      }
      target.joinAnswerPattern = value;
      return true;
    }
    case "allowColleges":
    case "denyColleges":
    case "allowYears":
    case "denyYears": {
      if (!isStringArray(value)) {
        return false;
      }
      target[key] = value;
      return true;
    }
    default:
      return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isKeywordPunish(value: unknown): value is KeywordPunishType {
  return (Object.values(KeywordPunish) as unknown[]).includes(value);
}

function isJoinDecisionMode(value: unknown): value is JoinDecisionModeType {
  return (Object.values(JoinDecisionMode) as unknown[]).includes(value);
}
