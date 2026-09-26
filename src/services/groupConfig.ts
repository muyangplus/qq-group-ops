import type { GroupConfigRepository } from "../db/groupConfigRepository.js";
import type { GroupSettingsRepository } from "../db/groupSettingsRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import {
  GroupConfig,
  EffectiveGroupConfig,
  GroupConfigOverride,
  DEFAULT_GROUP_ID,
  SQL_FIELDS,
  SETTING_FIELDS,
  GroupSettingKey,
  DEFAULT_CONFIG,
  normalizeKeywords,
  normalizeOverride,
  slimOverride,
  overriddenFieldsOf,
  fieldsFromConfig,
  PERSISTED_FIELD_ORDER,
  cloneConfig,
  mergeIntoDefault,
  hasAnyField,
  parseSettingValue,
  applySettingField,
} from "./groupConfigCore.js";

export { DEFAULT_GROUP_ID, PERSISTED_CONFIG_FIELDS, SETTING_FIELDS } from "./groupConfigCore.js";
export type { EffectiveGroupConfig, GroupConfig, GroupConfigOverride, GroupSettingKey, PersistedConfigField } from "./groupConfigCore.js";

/**
 * groupConfig 服务主体（类型、常量与纯函数见 groupConfigCore.ts）。
 */

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
      regexRules: normalizeKeywords(
        defaultConfig.regexRules ?? DEFAULT_CONFIG.regexRules,
      ),
      userWhitelist: normalizeKeywords(
        defaultConfig.userWhitelist ?? DEFAULT_CONFIG.userWhitelist,
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
      regexRules: override.regexRules ?? this.defaultConfig.regexRules,
      userWhitelist:
        override.userWhitelist ?? this.defaultConfig.userWhitelist,
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
