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

const DEFAULT_CONFIG: EffectiveGroupConfig = {
  groupId: "__default__",
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
  private readonly defaultConfig: EffectiveGroupConfig;
  private readonly overrides = new Map<string, GroupConfigOverride>();
  private readonly repository: GroupConfigRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(
    defaultConfig: GroupConfig = { groupId: "__default__" },
    repository?: GroupConfigRepository,
    queue?: WriteQueue,
  ) {
    this.defaultConfig = {
      ...DEFAULT_CONFIG,
      ...defaultConfig,
      groupId: "__default__",
      keywords: normalizeKeywords(
        defaultConfig.keywords ?? DEFAULT_CONFIG.keywords,
      ),
    };
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const overrides = await this.repository.findAll();
    this.overrides.clear();
    for (const override of overrides) {
      this.overrides.set(override.groupId, normalizeOverride(override));
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public get default(): EffectiveGroupConfig {
    return { ...this.defaultConfig };
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

  public setOverride(override: GroupConfigOverride): void {
    if (override.groupId === "__default__") {
      throw new Error("cannot override the default group id");
    }
    const normalized = normalizeOverride(override);
    this.overrides.set(override.groupId, normalized);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("group-config.save", () =>
        repository.saveOverride(normalized),
      );
      if (normalized.keywords !== undefined) {
        const keywords = [...normalized.keywords];
        this.queue?.enqueue("group-config.keywords", () =>
          repository.replaceKeywords(override.groupId, keywords),
        );
      }
    }
  }

  public removeOverride(groupId: string): void {
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
