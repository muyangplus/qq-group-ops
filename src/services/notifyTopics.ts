import {
  PLATFORM_LEVEL_MIN,
  PermissionLevel,
  PlatformLevel,
  type GroupLevel,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { GroupSettingsRepository } from "../db/groupSettingsRepository.js";
import type { WriteQueue } from "../db/writeQueue.js";
import { DEFAULT_GROUP_ID } from "./groupConfigCore.js";
import type { PermissionService } from "./permissions.js";

const log = getLogger("notify-topics");

/** 订阅范围：`__all__` 表示「我担任审核员的所有群」，否则是 group_openid。 */
export const NOTIFY_SCOPE_ALL = "__all__";

/**
 * 通知话题（统一订阅模型）。
 *
 * - `join` / `punish` / `activity`：原有三频道，**名字不可改**，否则老订阅行（`频道:范围`）失配；
 * - `bot_join` / `bot_leave` / `friend` / `member_join` / `unknown_event`：事件类话题
 *   （当前仍是硬编码通知超管，接入订阅表的动作在 H6 做）。
 *
 * 所有话题共用 `notification_subscriptions` 一张表，存储键统一为 `话题:范围`
 * （`join:__all__` / `activity:<group_openid>` …）。
 */
export type NotifyChannel =
  | "join"
  | "punish"
  | "activity"
  | "bot_join"
  | "bot_leave"
  | "friend"
  | "member_join"
  | "unknown_event";

export const NOTIFY_CHANNELS: readonly NotifyChannel[] = [
  "join",
  "punish",
  "activity",
  "bot_join",
  "bot_leave",
  "friend",
  "member_join",
  "unknown_event",
];

export interface NotifyTopicMeta {
  /** 卡片上的完整名（例如「处罚与申诉」）。 */
  label: string;
  /** 按钮上的短名（例如「处罚」）。 */
  short: string;
  /** 用途说明。 */
  hint: string;
  /**
   * 全局默认门槛（两轴混排）：
   * `<= 0` 不限权限 / `110..140` 群内档 / `>= 200` 平台档（只看全局角色，不折算）。
   */
  defaultLevel: number;
  /** 「全部群」范围的**额外**要求：订阅者必须已绑定 QQ 号（活动通知的历史口径）。 */
  requiresBindingForAll?: boolean;
}

/**
 * 话题元数据（单一事实来源：默认门槛 / 标签 / 附加要求）。
 *
 * 门槛可在通知中心改（存 `__default__` 的 `notifyTopicLevels`），这里只是**默认值**。
 */
export const NOTIFY_TOPIC_META: Readonly<Record<NotifyChannel, NotifyTopicMeta>> = {
  join: {
    label: "入群申请",
    short: "入群",
    hint: "有新的待处理入群申请（或自动处理结果）时私信你",
    defaultLevel: PermissionLevel.GroupAdmin,
  },
  punish: {
    label: "处罚与申诉",
    short: "处罚",
    hint: "关键词处罚、申诉派发与申诉结果私信你",
    defaultLevel: PermissionLevel.Moderator,
  },
  activity: {
    label: "活动通知",
    short: "活动",
    hint: "群里有新活动发布时私信你",
    defaultLevel: PermissionLevel.Blacklisted,
    requiresBindingForAll: true,
  },
  bot_join: {
    label: "机器人入群",
    short: "机器人入群",
    hint: "机器人被拉进新群时私信你",
    defaultLevel: PlatformLevel.GlobalSuperAdmin,
  },
  bot_leave: {
    label: "机器人退群",
    short: "机器人退群",
    hint: "机器人被移出群时私信你",
    defaultLevel: PlatformLevel.GlobalSuperAdmin,
  },
  friend: {
    label: "好友变动",
    short: "好友",
    hint: "有人添加或删除机器人为好友时私信你",
    defaultLevel: PlatformLevel.GlobalSuperAdmin,
  },
  member_join: {
    label: "新成员加入",
    short: "新成员",
    hint: "有新成员加入群时私信你",
    defaultLevel: PlatformLevel.GlobalSuperAdmin,
  },
  unknown_event: {
    label: "未定义事件",
    short: "未知事件",
    hint: "机器人收到未定义的事件类型时告警（每个事件类型只通知一次）",
    defaultLevel: PlatformLevel.GlobalSuperAdmin,
  },
};

/** 官方事件类型 → 通知话题（没有映射的类型统一进 `unknown_event`）。 */
export const OFFICIAL_EVENT_TOPICS: Readonly<Record<string, NotifyChannel>> = {
  GROUP_ADD_ROBOT: "bot_join",
  GROUP_DEL_ROBOT: "bot_leave",
  GROUP_MEMBER_ADD: "member_join",
  FRIEND_ADD: "friend",
  FRIEND_DEL: "friend",
  C2C_FRIEND_ADD: "friend",
  C2C_FRIEND_DEL: "friend",
};

export function topicOfOfficialEvent(eventType: string): NotifyChannel {
  return OFFICIAL_EVENT_TOPICS[eventType] ?? "unknown_event";
}

/** 内置默认门槛（每个话题一份）。 */
export function defaultNotifyTopicLevels(): Record<NotifyChannel, number> {
  const levels = {} as Record<NotifyChannel, number>;
  for (const topic of NOTIFY_CHANNELS) {
    levels[topic] = NOTIFY_TOPIC_META[topic].defaultLevel;
  }
  return levels;
}

/** 全局门槛在 `group_settings` 里的键（全局行 = `__default__`）。 */
export const NOTIFY_TOPIC_LEVELS_KEY = "notifyTopicLevels";

/**
 * 退订墓碑在 `group_settings` 里的键：`["<话题>:<用户>", …]`。
 *
 * 超管专属话题是**默认开**（启动时种订阅行），若退订只删行，下次启动又会被种回来，
 * 等于退订无效。所以退订要留一行墓碑，`seedSuperAdminDefaults` 见到墓碑就跳过；
 * 重新订阅时把墓碑删掉。
 */
export const NOTIFY_OPT_OUT_KEY = "notifyOptOut";

/** 门槛允许的取值范围：`-1`（不限）到最高平台档。 */
const MIN_TOPIC_LEVEL = PermissionLevel.Blacklisted;
const MAX_TOPIC_LEVEL = PlatformLevel.GlobalSuperAdmin;

function isTopicLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TOPIC_LEVEL &&
    value <= MAX_TOPIC_LEVEL
  );
}

/**
 * 解析持久化的话题门槛：缺键 / 坏 JSON / 非法值一律**逐项回落到默认值**
 * （老库没有这个键时必须能正常启动）。
 */
export function parseNotifyTopicLevels(
  raw: string | undefined,
): Record<NotifyChannel, number> {
  const levels = defaultNotifyTopicLevels();
  if (raw === undefined || raw.length === 0) {
    return levels;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("invalid notify topic levels json, falling back to defaults");
    return levels;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log.warn("notify topic levels is not an object, falling back to defaults");
    return levels;
  }
  const record = parsed as Record<string, unknown>;
  for (const topic of NOTIFY_CHANNELS) {
    const value = record[topic];
    if (isTopicLevel(value)) {
      levels[topic] = value;
    }
  }
  return levels;
}

/**
 * 收件 / 订阅资格的**唯一判据**（推送路径与订阅路径共用，避免「订阅成功却收不到」）。
 *
 * - `level <= 0`：不限权限（活动通知的历史口径）；
 * - `level >= PLATFORM_LEVEL_MIN`：平台档，只看全局角色（`meetsGlobal` 不做折算）；
 * - 其余是群内档：`scope` 为具体群时按该群折算判定；`scope` 为「全部群」时
 *   = 全局超管，或「至少在某个群达到该档」。
 *
 * 注意：推送路径传**具体群**（订阅了「全部群」也要在该群有角色，与历史行为一致），
 * 订阅路径传用户点的那个范围 —— 范围语义由调用方决定，门槛语义在这里统一。
 */
export function meetsNotifyLevel(
  permissions: PermissionService,
  userId: string,
  level: number,
  scope: string,
): boolean {
  if (level <= PermissionLevel.Guest) {
    return true;
  }
  if (level >= PLATFORM_LEVEL_MIN) {
    return permissions.meetsGlobal(userId, level as PlatformLevel);
  }
  const required = level as GroupLevel;
  if (scope === NOTIFY_SCOPE_ALL) {
    return (
      permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin) ||
      permissions.meetsAnywhere(userId, required)
    );
  }
  return permissions.meetsInGroup(userId, scope, required);
}

/** 墓碑键：`<话题>:<用户 id>`（话题名与 openid 都不含冒号）。 */
function optOutKey(topic: NotifyChannel, userId: string): string {
  return `${topic}:${userId}`;
}

/** 解析墓碑行；坏 JSON / 非数组一律当成「没有墓碑」。 */
export function parseNotifyOptOut(raw: string | undefined): Set<string> {
  if (raw === undefined || raw.length === 0) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("invalid notify opt-out json, treating as empty");
    return new Set();
  }
  if (!Array.isArray(parsed)) {
    return new Set();
  }
  return new Set(
    parsed.filter((item): item is string => typeof item === "string"),
  );
}

/**
 * 话题门槛的全局存储（`group_settings` 的 `__default__` 行）。
 *
 * 只存**两个**键：`notifyTopicLevels`（JSON map）与 `notifyOptOut`（退订墓碑）；
 * 不走 `GroupConfigStore` 是为了避免把它变成「每群可覆盖」的规则字段。
 */
export class NotifyTopicLevelStore {
  private levels: Record<NotifyChannel, number> = defaultNotifyTopicLevels();
  private optOut = new Set<string>();

  public constructor(
    private readonly repository?: GroupSettingsRepository | undefined,
    private readonly queue?: WriteQueue | undefined,
  ) {}

  public async load(): Promise<void> {
    const rows = (await this.repository?.findAll()) ?? [];
    const find = (key: string): string | undefined =>
      rows.find(
        (setting) =>
          setting.groupId === DEFAULT_GROUP_ID && setting.key === key,
      )?.value;
    this.levels = parseNotifyTopicLevels(find(NOTIFY_TOPIC_LEVELS_KEY));
    this.optOut = parseNotifyOptOut(find(NOTIFY_OPT_OUT_KEY));
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  /** 该用户是否显式退订过这个话题（默认开的话题靠它挡住重新播种）。 */
  public isOptedOut(topic: NotifyChannel, userId: string): boolean {
    return this.optOut.has(optOutKey(topic, userId));
  }

  /** 记一行退订墓碑（幂等）。 */
  public markOptedOut(topic: NotifyChannel, userId: string): void {
    const key = optOutKey(topic, userId);
    if (this.optOut.has(key)) {
      return;
    }
    this.optOut.add(key);
    this.persistOptOut();
  }

  /** 重新订阅时清掉墓碑。 */
  public clearOptOut(topic: NotifyChannel, userId: string): void {
    if (!this.optOut.delete(optOutKey(topic, userId))) {
      return;
    }
    this.persistOptOut();
  }

  /** 话题的当前门槛。 */
  public levelOf(topic: NotifyChannel): number {
    return this.levels[topic];
  }

  /** 当前门槛 >= 平台档下限的话题（「超管专属」，默认给现有全局超管开订阅）。 */
  public superAdminTopics(): NotifyChannel[] {
    return NOTIFY_CHANNELS.filter(
      (topic) => this.levels[topic] >= PLATFORM_LEVEL_MIN,
    );
  }

  /** 改某个话题的门槛（通知中心用；改完立即对推送与订阅生效）。 */
  public setLevel(topic: NotifyChannel, level: number): void {
    if (!isTopicLevel(level)) {
      throw new Error(
        `话题门槛必须是 ${MIN_TOPIC_LEVEL}..${MAX_TOPIC_LEVEL} 之间的整数（收到 ${level}）`,
      );
    }
    this.levels = { ...this.levels, [topic]: level };
    this.persist();
  }

  /** 当前全部门槛（副本，供卡片展示）。 */
  public snapshot(): Record<NotifyChannel, number> {
    return { ...this.levels };
  }

  private persist(): void {
    if (!this.repository) {
      return;
    }
    const value = JSON.stringify(this.levels);
    this.queue?.enqueue("notify.topicLevels.save", () =>
      this.repository!.save({
        groupId: DEFAULT_GROUP_ID,
        key: NOTIFY_TOPIC_LEVELS_KEY,
        value,
      }),
    );
  }

  private persistOptOut(): void {
    if (!this.repository) {
      return;
    }
    const value = JSON.stringify([...this.optOut].sort());
    this.queue?.enqueue("notify.optOut.save", () =>
      this.repository!.save({
        groupId: DEFAULT_GROUP_ID,
        key: NOTIFY_OPT_OUT_KEY,
        value,
      }),
    );
  }
}
