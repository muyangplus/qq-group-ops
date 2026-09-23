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
};

export class GroupConfigStore {
  /** 构造函数（或内置默认值）提供的初始配置，用于 reset 与 reload 的基准。 */
  private readonly builtinConfig: EffectiveGroupConfig;
  /** 当前生效的全局默认配置：builtin + 持久化的全局覆盖。 */
  private defaultConfig: EffectiveGroupConfig;
  private readonly overrides = new Map<string, GroupConfigOverride>();
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
    };
    this.defaultConfig = cloneConfig(this.builtinConfig);
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
    this.defaultConfig = cloneConfig(this.builtinConfig);

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
    this.persistGroupOverride(override.groupId, merged, override);
  }

  /** 全局规则：整行快照 + 扩展键值。 */
  private setDefaultOverride(override: GroupConfigOverride): void {
    this.defaultConfig = mergeIntoDefault(
      this.defaultConfig,
      normalizeOverride(override),
    );
    const repository = this.repository;
    if (repository) {
      const snapshot = defaultSnapshot(this.defaultConfig);
      this.queue?.enqueue("group-config.default.save", () =>
        repository.saveOverride(snapshot),
      );
      if (override.keywords !== undefined) {
        const keywords = [...this.defaultConfig.keywords];
        this.queue?.enqueue("group-config.default.keywords", () =>
          repository.replaceKeywords(DEFAULT_GROUP_ID, keywords),
        );
      }
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
    if (override.groupId === DEFAULT_GROUP_ID) {
      this.defaultConfig = mergeIntoDefault(
        this.defaultConfig,
        normalizeOverride(override),
      );
      return;
    }
    const existing = this.overrides.get(override.groupId);
    this.overrides.set(
      override.groupId,
      normalizeOverride({ ...existing, ...override, groupId: override.groupId }),
    );
  }

  /**
   * 移除覆盖：单群回落到全局默认；`__default__` 回落到内置初始配置。
   */
  public removeOverride(groupId: string): void {
    if (groupId === DEFAULT_GROUP_ID) {
      this.defaultConfig = cloneConfig(this.builtinConfig);
    }
    this.overrides.delete(groupId);
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
  if (override.keywords === undefined) {
    return { ...override };
  }
  return { ...override, keywords: normalizeKeywords(override.keywords) };
}

function cloneConfig(config: EffectiveGroupConfig): EffectiveGroupConfig {
  return { ...config, keywords: [...config.keywords] };
}

/** 把局部覆盖合并到全局默认配置上。 */
function mergeIntoDefault(
  base: EffectiveGroupConfig,
  override: GroupConfigOverride,
): EffectiveGroupConfig {
  return {
    groupId: DEFAULT_GROUP_ID,
    enabled: override.enabled ?? base.enabled,
    joinAuditEnabled: override.joinAuditEnabled ?? base.joinAuditEnabled,
    autoApproveJoin: override.autoApproveJoin ?? base.autoApproveJoin,
    keywords:
      override.keywords !== undefined
        ? normalizeKeywords(override.keywords)
        : base.keywords,
    wordFilterEnabled: override.wordFilterEnabled ?? base.wordFilterEnabled,
    exportEnabled: override.exportEnabled ?? base.exportEnabled,
    rawMessageRetentionDays:
      override.rawMessageRetentionDays ?? base.rawMessageRetentionDays,
    muteDurationSeconds:
      override.muteDurationSeconds ?? base.muteDurationSeconds,
    warningMessage: override.warningMessage ?? base.warningMessage,
    keywordRecall: override.keywordRecall ?? base.keywordRecall,
    keywordPunish: override.keywordPunish ?? base.keywordPunish,
    joinDecision: override.joinDecision ?? base.joinDecision,
    joinRequireClass: override.joinRequireClass ?? base.joinRequireClass,
    joinRequireName: override.joinRequireName ?? base.joinRequireName,
    joinAnswerPattern: override.joinAnswerPattern ?? base.joinAnswerPattern,
    joinReviewOpinion: override.joinReviewOpinion ?? base.joinReviewOpinion,
  };
}

/** 全局规则的 SQL 持久化快照（扩展字段走 group_settings）。 */
function defaultSnapshot(config: EffectiveGroupConfig): GroupConfigOverride {
  return {
    groupId: DEFAULT_GROUP_ID,
    enabled: config.enabled,
    joinAuditEnabled: config.joinAuditEnabled,
    autoApproveJoin: config.autoApproveJoin,
    keywords: [...config.keywords],
    wordFilterEnabled: config.wordFilterEnabled,
    exportEnabled: config.exportEnabled,
    rawMessageRetentionDays: config.rawMessageRetentionDays,
    muteDurationSeconds: config.muteDurationSeconds,
    warningMessage: config.warningMessage,
  };
}

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
    case "joinReviewOpinion": {
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
    default:
      return false;
  }
}

function isKeywordPunish(value: unknown): value is KeywordPunishType {
  return (Object.values(KeywordPunish) as unknown[]).includes(value);
}

function isJoinDecisionMode(value: unknown): value is JoinDecisionModeType {
  return (Object.values(JoinDecisionMode) as unknown[]).includes(value);
}
