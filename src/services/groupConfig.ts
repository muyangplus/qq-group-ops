import type { GroupConfigRepository } from "../db/groupConfigRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

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
}

export interface GroupConfigOverride {
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
}

/** 全局默认配置使用的保留 group id。 */
export const DEFAULT_GROUP_ID = "__default__";

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
};

export class GroupConfigStore {
  /** 构造函数（或内置默认值）提供的初始配置，用于 reset 与 reload 的基准。 */
  private readonly builtinConfig: EffectiveGroupConfig;
  /** 当前生效的全局默认配置：builtin + 持久化的全局覆盖。 */
  private defaultConfig: EffectiveGroupConfig;
  private readonly overrides = new Map<string, GroupConfigOverride>();
  private readonly repository: GroupConfigRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(
    defaultConfig: GroupConfig = { groupId: DEFAULT_GROUP_ID },
    repository?: GroupConfigRepository,
    queue?: WriteQueue,
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
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  /**
   * 从数据库载入配置。
   *
   * `__default__` 行代表全局规则，会合并进全局默认配置；其余行是单群覆盖。
   */
  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const overrides = await this.repository.findAll();
    this.overrides.clear();
    this.defaultConfig = cloneConfig(this.builtinConfig);
    for (const override of overrides) {
      if (override.groupId === DEFAULT_GROUP_ID) {
        this.defaultConfig = mergeIntoDefault(
          this.defaultConfig,
          normalizeOverride(override),
        );
        continue;
      }
      this.overrides.set(override.groupId, normalizeOverride(override));
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
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("group-config.save", () =>
        repository.saveOverride(merged),
      );
      if (override.keywords !== undefined) {
        const keywords = [...(merged.keywords ?? [])];
        this.queue?.enqueue("group-config.keywords", () =>
          repository.replaceKeywords(override.groupId, keywords),
        );
      }
    }
  }

  /** 全局规则始终持久化完整快照，避免多次局部更新互相覆盖。 */
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
  };
}

/** 全局规则的持久化快照：所有字段都写全，避免局部更新覆盖历史值。 */
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
