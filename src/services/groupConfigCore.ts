import {
  JoinDecisionMode,
  KeywordPunish,
  JoinDecisionMode as JoinDecisionModeType,
  KeywordPunish as KeywordPunishType,
} from "../core/enums.js";

/**
 * groupConfig 的类型、常量与纯函数（从 groupConfig.ts 拆出；主文件会原样再导出公开名字）。
 */


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
export const SQL_FIELDS = [
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

export const DEFAULT_CONFIG: EffectiveGroupConfig = {
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

export function normalizeKeywords(keywords: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }
  return [...unique].sort();
}

export function normalizeOverride(override: GroupConfigOverride): GroupConfigOverride {
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
export function slimOverride(override: GroupConfigOverride): GroupConfigOverride {
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
export function overriddenFieldsOf(
  override: GroupConfigOverride,
): Array<keyof GroupConfigOverride> {
  return PERSISTED_CONFIG_FIELDS.filter(
    (field) => override[field] !== undefined,
  );
}

/** 从种子默认配置里摘出指定字段（全局「恢复本页继承」回落用）。 */
export function fieldsFromConfig(
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
export const PERSISTED_FIELD_ORDER: readonly (keyof GroupConfigOverride)[] =
  PERSISTED_CONFIG_FIELDS;

export function cloneConfig(config: EffectiveGroupConfig): EffectiveGroupConfig {
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
export function mergeIntoDefault(
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
export function hasAnyField(
  override: GroupConfigOverride,
  fields: readonly (keyof GroupConfigOverride)[],
): boolean {
  return fields.some((field) => override[field] !== undefined);
}

export function parseSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // 兼容早期直接写入的裸字符串
    return raw;
  }
}

/** 把 `group_settings` 里的一行写成类型安全的覆盖字段。 */
export function applySettingField(
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

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isKeywordPunish(value: unknown): value is KeywordPunishType {
  return (Object.values(KeywordPunish) as unknown[]).includes(value);
}

export function isJoinDecisionMode(value: unknown): value is JoinDecisionModeType {
  return (Object.values(JoinDecisionMode) as unknown[]).includes(value);
}
