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

  public constructor(defaultConfig: GroupConfig = { groupId: "__default__" }) {
    this.defaultConfig = {
      ...DEFAULT_CONFIG,
      ...defaultConfig,
      groupId: "__default__",
    };
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
    this.overrides.set(override.groupId, { ...override });
  }

  public removeOverride(groupId: string): void {
    this.overrides.delete(groupId);
  }

  public listOverrides(): GroupConfigOverride[] {
    return [...this.overrides.values()].map((override) => ({ ...override }));
  }
}
