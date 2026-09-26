import {
  JoinDecisionMode,
  KeywordPunish,
  JoinDecisionMode as JoinDecisionModeType,
  KeywordPunish as KeywordPunishType,
} from "../core/enums.js";

/**
 * groupConfig 的类型、常量与纯函数（从 groupConfig.ts 拆出；主文件会原样再导出公开名字）。
 */


/** 违规处理动作（§B2 多选重构 2026-09-26）：五个动作互相独立、可任意组合。 */
export interface PunishActions {
  /** 发送群规则警告文案（处罚通知卡）。 */
  warn: boolean;
  /** 撤回命中消息。 */
  recall: boolean;
  /** 禁言（时长取 `muteDurationSeconds`）。 */
  mute: boolean;
  /** 移出群。 */
  kick: boolean;
  /** 拉黑（本群）：落本地黑名单 + 尝试官方拉黑；官方要求目标不在群中，失败只记日志。 */
  blacklist: boolean;
}

export const PUNISH_ACTION_KEYS = [
  "warn",
  "recall",
  "mute",
  "kick",
  "blacklist",
] as const;
export type PunishActionKey = (typeof PUNISH_ACTION_KEYS)[number];

export const PUNISH_ACTION_LABELS: Record<PunishActionKey, string> = {
  warn: "警告",
  recall: "撤回",
  mute: "禁言",
  kick: "踢出",
  blacklist: "拉黑",
};

/** 默认只警告（与重构前的默认行为一致：`keywordPunish=none` + 不撤回）。 */
export const DEFAULT_PUNISH_ACTIONS: PunishActions = {
  warn: true,
  recall: false,
  mute: false,
  kick: false,
  blacklist: false,
};

/** 容错解析五动作集合；没有任何有效布尔值时返回 `undefined`（视为未设置）。 */
export function normalizePunishActions(value: unknown): PunishActions | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const result: PunishActions = { ...DEFAULT_PUNISH_ACTIONS };
  let seen = false;
  for (const key of PUNISH_ACTION_KEYS) {
    if (typeof source[key] === "boolean") {
      result[key] = source[key];
      seen = true;
    }
  }
  return seen ? result : undefined;
}

/**
 * 老配置自动换算：`keywordPunish` 枚举 + `keywordRecall` 布尔 → 五动作集合。
 *
 * - `none` → 只警告（默认开）
 * - `mute` → 禁言（+警告）
 * - `kick` → 踢出（+警告）
 * - `kick_blacklist` → 踢出 + 拉黑（+警告）
 * - `keywordRecall` → 撤回
 */
export function punishActionsFromLegacy(
  punish: unknown,
  recall: unknown,
): PunishActions {
  const actions: PunishActions = { ...DEFAULT_PUNISH_ACTIONS };
  if (recall === true) {
    actions.recall = true;
  }
  switch (punish) {
    case KeywordPunish.Mute:
      actions.mute = true;
      break;
    case KeywordPunish.Kick:
      actions.kick = true;
      break;
    case KeywordPunish.KickBlacklist:
      actions.kick = true;
      actions.blacklist = true;
      break;
    default:
      break;
  }
  return actions;
}

/** 五动作的中文描述（卡片与审计复用）：`警告 + 撤回 + 禁言` / `仅警告` / `不处理`。 */
export function describePunishActions(actions: PunishActions): string {
  const labels = PUNISH_ACTION_KEYS.filter((key) => actions[key]).map(
    (key) => PUNISH_ACTION_LABELS[key],
  );
  if (labels.length === 0) {
    return "不处理";
  }
  return labels.join(" + ");
}

/** 动作集合是否为空（什么都不做）。 */
export function isEmptyPunishActions(actions: PunishActions): boolean {
  return PUNISH_ACTION_KEYS.every((key) => !actions[key]);
}

export interface GroupConfig {
  groupId: string;
  enabled?: boolean;
  joinAuditEnabled?: boolean;
  autoApproveJoin?: boolean;
  keywords?: readonly string[];
  /** 消息侧正则规则：每条一个正则，命中后与关键词走同一条处罚管道（§B1）。 */
  regexRules?: readonly string[];
  /** 用户白名单：这些 userId 不做关键词 / 正则判断（审核员豁免之外的补充，§B1）。 */
  userWhitelist?: readonly string[];
  wordFilterEnabled?: boolean;
  exportEnabled?: boolean;
  rawMessageRetentionDays?: number;
  muteDurationSeconds?: number;
  warningMessage?: string;
  /**
   * 违规处理动作（多选）：警告 / 撤回 / 禁言 / 踢出 / 拉黑（§B2 2026-09-26 重构）。
   *
   * 覆盖时是**整组替换**（不是逐位合并），避免"只改一个开关"把别的动作带偏。
   */
  punishActions?: PunishActions;
  /** @deprecated 老字段（`keywordRecall` + `keywordPunish`），只在读取旧库时换算成 `punishActions`。 */
  keywordRecall?: boolean;
  /** @deprecated 老字段，见 `punishActionsFromLegacy`。 */
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
  regexRules: readonly string[];
  userWhitelist: readonly string[];
  wordFilterEnabled: boolean;
  exportEnabled: boolean;
  rawMessageRetentionDays: number;
  muteDurationSeconds: number;
  warningMessage: string;
  punishActions: PunishActions;
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
  "punishActions",
  "regexRules",
  "userWhitelist",
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
  regexRules: [],
  userWhitelist: [],
  wordFilterEnabled: true,
  exportEnabled: false,
  rawMessageRetentionDays: 0,
  muteDurationSeconds: 600,
  warningMessage: "请遵守群规，不要发送违规内容。",
  punishActions: { ...DEFAULT_PUNISH_ACTIONS },
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
  const actions = normalizePunishActions(override.punishActions);
  return {
    ...override,
    ...(actions !== undefined ? { punishActions: actions } : {}),
    ...(override.keywords !== undefined
      ? { keywords: normalizeKeywords(override.keywords) }
      : {}),
    ...(override.regexRules !== undefined
      ? { regexRules: normalizeKeywords(override.regexRules) }
      : {}),
    ...(override.userWhitelist !== undefined
      ? { userWhitelist: normalizeKeywords(override.userWhitelist) }
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
    // 老字段（keywordRecall / keywordPunish）不在生效配置里，跳过即可
    if (field in config) {
      (result as unknown as Record<string, unknown>)[field] = (
        config as unknown as Record<string, unknown>
      )[field];
    }
  }
  return result;
}

/** 覆盖率总览里字段的展示顺序：按持久化清单（SQL 在前、扩展在后）。 */
export const PERSISTED_FIELD_ORDER: readonly (keyof GroupConfigOverride)[] =
  PERSISTED_CONFIG_FIELDS;

export function cloneConfig(config: EffectiveGroupConfig): EffectiveGroupConfig {
  return {
    ...config,
    punishActions: { ...config.punishActions },
    keywords: [...config.keywords],
    regexRules: [...config.regexRules],
    userWhitelist: [...config.userWhitelist],
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
    punishActions:
      normalizePunishActions(override.punishActions) ?? base.punishActions,
    keywords:
      override.keywords !== undefined
        ? normalizeKeywords(override.keywords)
        : base.keywords,
    regexRules:
      override.regexRules !== undefined
        ? normalizeKeywords(override.regexRules)
        : base.regexRules,
    userWhitelist:
      override.userWhitelist !== undefined
        ? normalizeKeywords(override.userWhitelist)
        : base.userWhitelist,
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
    case "punishActions": {
      const actions = normalizePunishActions(value);
      if (actions === undefined) {
        return false;
      }
      target.punishActions = actions;
      return true;
    }
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
    // 老配置自动换算：老库里的 `keywordRecall` / `keywordPunish` 仍按**原字段**读进来，
    // 由 `GroupConfigStore.get()` 在合并完成后一次性折算成 `punishActions`
    // （逐行折算会丢信息：两条老记录是分开的两行，先后覆盖会互相清掉）。
    case "keywordRecall": {
      if (typeof value !== "boolean") {
        return false;
      }
      target.keywordRecall = value;
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
    case "regexRules":
    case "userWhitelist":
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
