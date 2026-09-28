import { getLogger } from "../core/logger.js";
import type { ActivityDetails } from "./activity.js";
import type { ActivityDetailsRepository } from "../db/activityDetailsRepository.js";
import type {
  GroupSetting,
  GroupSettingsRepository,
} from "../db/groupSettingsRepository.js";
import type {
  ShortCodeEntry,
  ShortCodeRepository,
} from "../db/shortCodeRepository.js";
import type { UserProfileRepository } from "../db/userProfileRepository.js";
import type { UserProfile } from "./userProfiles.js";
import { DEFAULT_PUNISH_ACTIONS, type PunishActions } from "./groupConfigCore.js";

const log = getLogger("data-migration");

/** `punishActions` 在 `group_settings` 里的键；老键折算后写入它。 */
const PUNISH_ACTIONS_KEY = "punishActions";
const LEGACY_PUNISH_KEY = "keywordPunish";
const LEGACY_RECALL_KEY = "keywordRecall";
const YEAR_LIST_KEYS = new Set(["allowYears", "denyYears"]);

/**
 * 一次性数据迁移的待处理条数。
 *
 * 每一项都是**仍需处理**的条数：全部为 0 表示库里的数据已是现行格式
 * （迁移幂等，重复执行不会重复改写）。
 */
export interface MigrationCounts {
  /** `group_settings` 里需要改写的行：裸字符串值、含四位年级的年级名单。 */
  settings: number;
  /** 还在用 `keywordPunish` / `keywordRecall` 的群（折算成 `punishActions` 并删掉老键）。 */
  legacyPunishGroups: number;
  /** `user_profiles` 里四位年份的条数。 */
  profileYears: number;
  /** `activity_details` 里含小写字母的活动码条数。 */
  activityCodes: number;
  /** `activity_details` 里含四位年级的条数。 */
  activityYears: number;
  /** `short_codes` 里含小写字母的条数。 */
  shortCodes: number;
}

export function totalPending(counts: MigrationCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export interface DataMigrationDeps {
  settings?: GroupSettingsRepository | undefined;
  profiles?: UserProfileRepository | undefined;
  activityDetails?: ActivityDetailsRepository | undefined;
  shortCodes?: ShortCodeRepository | undefined;
  /** 新短码 / 活动码生成器：线上用与业务同一份全局码池，保证不与现有码重码。 */
  generateCode: () => string;
  /** 迁移完成后重载内存态（配置 / 个人资料 / 短码 / 活动）。 */
  reload?: (() => Promise<void>) | undefined;
}

/** 一行 `group_settings` 的改写。 */
interface SettingRewrite {
  groupId: string;
  key: string;
  value: string;
}

/** 一个群里待折算的老处罚字段。 */
interface LegacyPunishEdit {
  groupId: string;
  rows: GroupSetting[];
  /** 该群是否已经有 `punishActions`：有则只清理老键，不覆盖新值。 */
  hasNewRow: boolean;
  recall: unknown;
  punish: unknown;
}

/** 一个活动的改写：换码与年级收敛可能同时发生。 */
interface ActivityEdit {
  details: ActivityDetails;
  codeChanged: boolean;
  yearsChanged: boolean;
}

interface ScanResult {
  rewrites: SettingRewrite[];
  legacyPunish: LegacyPunishEdit[];
  profiles: UserProfile[];
  activities: ActivityEdit[];
  codes: ShortCodeEntry[];
}

/**
 * 一次性数据迁移：把库里早期版本写下的内容转成现行格式。
 *
 * 只做**存储层改写**，不参与业务读取；迁移完成后主体代码不再兼容老格式。
 * 四类目标：
 * 1. `group_settings` 的裸字符串值（早期直接写字符串，未做 JSON 编码）；
 * 2. `keywordPunish` + `keywordRecall` 折算成 `punishActions`（五动作集合）；
 * 3. 四位年份（`2022`）收敛成两位（`22`）：群规则的年级名单、个人资料、活动报名限制；
 * 4. 含小写字母的短码 / 活动码，重新生成为「数字 + 大写字母」。
 */
export class DataMigrationService {
  private readonly settings: GroupSettingsRepository | undefined;
  private readonly profiles: UserProfileRepository | undefined;
  private readonly activityDetails: ActivityDetailsRepository | undefined;
  private readonly shortCodes: ShortCodeRepository | undefined;
  private readonly generateCode: () => string;
  private readonly reload: (() => Promise<void>) | undefined;

  public constructor(deps: DataMigrationDeps) {
    this.settings = deps.settings;
    this.profiles = deps.profiles;
    this.activityDetails = deps.activityDetails;
    this.shortCodes = deps.shortCodes;
    this.generateCode = deps.generateCode;
    this.reload = deps.reload;
  }

  /** 四张表都接上仓储才具备迁移能力（缺库时只读预览与执行都无意义）。 */
  public get persistent(): boolean {
    return (
      this.settings !== undefined &&
      this.profiles !== undefined &&
      this.activityDetails !== undefined &&
      this.shortCodes !== undefined
    );
  }

  /** 只读预览：扫描待迁移条数，不改库。 */
  public async plan(): Promise<MigrationCounts> {
    return countsOf(await this.scan());
  }

  /** 执行迁移（幂等）：先扫描再改写，改完重载内存态。返回本次改写的条数。 */
  public async run(): Promise<MigrationCounts> {
    if (!this.persistent) {
      throw new Error("数据迁移需要已连接的数据库");
    }
    const scan = await this.scan();
    const counts = countsOf(scan);
    if (totalPending(counts) === 0) {
      return counts;
    }
    await this.apply(scan);
    await this.reload?.();
    log.info("legacy data migrated", { ...counts });
    return counts;
  }

  private async scan(): Promise<ScanResult> {
    const result: ScanResult = {
      rewrites: [],
      legacyPunish: [],
      profiles: [],
      activities: [],
      codes: [],
    };
    if (this.settings) {
      const rows = await this.settings.findAll();
      const hasPunishActions = new Set(
        rows
          .filter((row) => row.key === PUNISH_ACTIONS_KEY)
          .map((row) => row.groupId),
      );
      const legacy = new Map<string, LegacyPunishEdit>();
      for (const row of rows) {
        const decoded = decodeSettingValue(row.value);
        if (decoded.bare) {
          result.rewrites.push({
            groupId: row.groupId,
            key: row.key,
            value: JSON.stringify(row.value),
          });
        }
        if (row.key === LEGACY_RECALL_KEY || row.key === LEGACY_PUNISH_KEY) {
          const edit = legacy.get(row.groupId) ?? {
            groupId: row.groupId,
            rows: [],
            hasNewRow: hasPunishActions.has(row.groupId),
            recall: undefined,
            punish: undefined,
          };
          edit.rows.push(row);
          if (row.key === LEGACY_RECALL_KEY) {
            edit.recall = decoded.value;
          } else {
            edit.punish = decoded.value;
          }
          legacy.set(row.groupId, edit);
          continue;
        }
        if (YEAR_LIST_KEYS.has(row.key)) {
          const normalized = collapseYearList(decoded.value);
          if (normalized) {
            result.rewrites.push({
              groupId: row.groupId,
              key: row.key,
              value: JSON.stringify(normalized),
            });
          }
        }
      }
      result.legacyPunish = [...legacy.values()];
    }
    if (this.profiles) {
      for (const profile of await this.profiles.findAll()) {
        const year = collapseYear(profile.year);
        if (year !== profile.year) {
          result.profiles.push({ ...profile, year });
        }
      }
    }
    if (this.activityDetails) {
      for (const details of await this.activityDetails.findAll()) {
        const codeChanged = details.code !== details.code.toUpperCase();
        const allowYears = collapseYearList(details.rules.allowYears);
        const denyYears = collapseYearList(details.rules.denyYears);
        const yearsChanged = allowYears !== undefined || denyYears !== undefined;
        if (!codeChanged && !yearsChanged) {
          continue;
        }
        result.activities.push({
          details: {
            ...details,
            rules: {
              ...details.rules,
              ...(allowYears ? { allowYears } : {}),
              ...(denyYears ? { denyYears } : {}),
            },
          },
          codeChanged,
          yearsChanged,
        });
      }
    }
    if (this.shortCodes) {
      for (const entry of await this.shortCodes.findAll()) {
        if (entry.code !== entry.code.toUpperCase()) {
          result.codes.push(entry);
        }
      }
    }
    return result;
  }

  private async apply(scan: ScanResult): Promise<void> {
    const settings = this.settings;
    if (settings) {
      for (const rewrite of scan.rewrites) {
        await settings.save(rewrite);
      }
      for (const edit of scan.legacyPunish) {
        if (!edit.hasNewRow) {
          await settings.save({
            groupId: edit.groupId,
            key: PUNISH_ACTIONS_KEY,
            value: JSON.stringify(
              punishActionsFromLegacy(edit.punish, edit.recall),
            ),
          });
        }
        await settings.remove(edit.groupId, LEGACY_RECALL_KEY);
        await settings.remove(edit.groupId, LEGACY_PUNISH_KEY);
      }
    }
    if (this.profiles) {
      for (const profile of scan.profiles) {
        await this.profiles.save(profile);
      }
    }
    if (this.activityDetails) {
      for (const edit of scan.activities) {
        // 换码在写入时取，保证预览（plan）不占用码池
        const details = edit.codeChanged
          ? { ...edit.details, code: this.generateCode() }
          : edit.details;
        await this.activityDetails.save(details);
      }
    }
    if (this.shortCodes) {
      for (const entry of scan.codes) {
        await this.shortCodes.replaceCode(entry.code, {
          ...entry,
          code: this.generateCode(),
        });
      }
    }
  }
}

function countsOf(scan: ScanResult): MigrationCounts {
  return {
    settings: scan.rewrites.length,
    legacyPunishGroups: scan.legacyPunish.length,
    profileYears: scan.profiles.length,
    activityCodes: scan.activities.filter((edit) => edit.codeChanged).length,
    activityYears: scan.activities.filter((edit) => edit.yearsChanged).length,
    shortCodes: scan.codes.length,
  };
}

interface DecodedSetting {
  value: unknown;
  /** 值不是合法 JSON（早期直接写入的裸字符串）。 */
  bare: boolean;
}

/** 读 `group_settings` 的值：合法 JSON 就解析，否则原样返回并标记为裸字符串。 */
function decodeSettingValue(raw: string): DecodedSetting {
  try {
    return { value: JSON.parse(raw) as unknown, bare: false };
  } catch {
    return { value: raw, bare: true };
  }
}

/** 四位年份 → 两位（`2022` → `22`）；其它值原样返回。 */
function collapseYear(value: string): string {
  const trimmed = value.trim();
  return /^\d{4}$/u.test(trimmed) ? trimmed.slice(2) : value;
}

/** 年级名单里是否有四位写法；有则返回收敛后的新数组，否则 `undefined`。 */
function collapseYearList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  const items = value as string[];
  const next = items.map((item) => collapseYear(item));
  return next.some((item, index) => item !== items[index]) ? next : undefined;
}

/**
 * 老字段折算（迁移专用）：`keywordPunish` 枚举 + `keywordRecall` 布尔 → 五动作集合。
 *
 * - `none` → 只警告（默认开）
 * - `mute` → 禁言（+警告）
 * - `kick` → 踢出（+警告）
 * - `kick_blacklist` → 踢出 + 拉黑（+警告）
 * - `keywordRecall` → 撤回
 */
function punishActionsFromLegacy(punish: unknown, recall: unknown): PunishActions {
  const actions: PunishActions = { ...DEFAULT_PUNISH_ACTIONS };
  if (recall === true) {
    actions.recall = true;
  }
  switch (punish) {
    case "mute":
      actions.mute = true;
      break;
    case "kick":
      actions.kick = true;
      break;
    case "kick_blacklist":
      actions.kick = true;
      actions.blacklist = true;
      break;
    default:
      break;
  }
  return actions;
}
