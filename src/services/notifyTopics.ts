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

/**
 * 通知订阅卡**当前**展示的话题。
 *
 * 卡片最多 5 行，8 个话题一次放不下；H4 会把它重做成「多选开关 + 分页」的面板，
 * 那时改为展示全量（`NOTIFY_CHANNELS`）。在那之前，事件类话题只参与门槛判定与
 * 默认开订阅（H6 接事件推送时才会被用到），不上菜单。
 */
export const NOTIFY_CARD_TOPICS: readonly NotifyChannel[] = [
  "join",
  "punish",
  "activity",
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

/**
 * 话题门槛的全局存储（`group_settings` 的 `__default__` 行）。
 *
 * 只存**一个**键 `notifyTopicLevels`（JSON map），改一次全群生效；
 * 不走 `GroupConfigStore` 是为了避免把它变成「每群可覆盖」的规则字段。
 */
export class NotifyTopicLevelStore {
  private levels: Record<NotifyChannel, number> = defaultNotifyTopicLevels();

  public constructor(
    private readonly repository?: GroupSettingsRepository | undefined,
    private readonly queue?: WriteQueue | undefined,
  ) {}

  public async load(): Promise<void> {
    const rows = await this.repository?.findAll();
    const row = rows?.find(
      (setting) =>
        setting.groupId === DEFAULT_GROUP_ID &&
        setting.key === NOTIFY_TOPIC_LEVELS_KEY,
    );
    this.levels = parseNotifyTopicLevels(row?.value);
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
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
}
