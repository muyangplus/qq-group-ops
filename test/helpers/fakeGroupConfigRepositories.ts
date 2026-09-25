import type { GroupConfigRepository } from "../../src/db/groupConfigRepository.js";
import { GROUP_CONFIG_COLUMNS } from "../../src/db/groupConfigRepository.js";
import type {
  GroupSetting,
  GroupSettingsRepository,
} from "../../src/db/groupSettingsRepository.js";
import type { GroupConfigOverride } from "../../src/services/groupConfig.js";

/**
 * 规则持久化的内存替身，行为与 SQL 仓储一致：
 * - `group_configs`：每群一行快照 + 单独的 `group_keywords`；
 * - `group_settings`：每群一组键值。
 *
 * 用于验证「规则配置全部入库」：`findAll()` 会把关键词合并回覆盖行，
 * 与 `SqlGroupConfigRepository.findAll()` 保持一致。
 */
export class FakeGroupConfigRepository implements GroupConfigRepository {
  public readonly overrides = new Map<string, GroupConfigOverride>();
  public readonly keywords = new Map<string, string[]>();

  public async loadOverride(
    groupId: string,
  ): Promise<GroupConfigOverride | null> {
    const override = this.overrides.get(groupId);
    return override ? { ...override } : null;
  }

  public async saveOverride(override: GroupConfigOverride): Promise<void> {
    // 与 SQL `group_configs` 一致：只落**列**字段。
    // 扩展字段（group_settings）与关键词（group_keywords）由各自的仓储负责，
    // 整行快照里混进 KV 字段会让 `clearColumns` / `findAll` 行为对不上真实 SQL。
    const row: GroupConfigOverride = { groupId: override.groupId };
    for (const field of Object.keys(GROUP_CONFIG_COLUMNS)) {
      const value = (override as unknown as Record<string, unknown>)[field];
      if (value !== undefined) {
        (row as unknown as Record<string, unknown>)[field] = value;
      }
    }
    this.overrides.set(override.groupId, row);
  }

  public async deleteOverride(groupId: string): Promise<void> {
    this.overrides.delete(groupId);
  }

  public async clearColumns(
    groupId: string,
    fields: readonly (keyof GroupConfigOverride)[],
  ): Promise<void> {
    const override = this.overrides.get(groupId);
    if (!override) {
      return;
    }
    const next: GroupConfigOverride = { ...override };
    for (const field of fields) {
      if (field in GROUP_CONFIG_COLUMNS) {
        delete next[field];
      }
    }
    this.overrides.set(groupId, next);
  }

  public async loadKeywords(groupId: string): Promise<string[]> {
    return [...(this.keywords.get(groupId) ?? [])];
  }

  public async replaceKeywords(
    groupId: string,
    keywords: readonly string[],
  ): Promise<void> {
    this.keywords.set(groupId, [...keywords]);
  }

  public async findAll(): Promise<GroupConfigOverride[]> {
    return [...this.overrides.values()].map((override) => ({
      ...override,
      ...(this.keywords.has(override.groupId)
        ? { keywords: [...(this.keywords.get(override.groupId) ?? [])] }
        : {}),
    }));
  }
}

export class FakeGroupSettingsRepository implements GroupSettingsRepository {
  public readonly rows = new Map<string, GroupSetting>();

  public async save(setting: GroupSetting): Promise<void> {
    this.rows.set(settingsKey(setting.groupId, setting.key), { ...setting });
  }

  public async remove(groupId: string, key: string): Promise<void> {
    this.rows.delete(settingsKey(groupId, key));
  }

  public async removeAll(groupId: string): Promise<void> {
    for (const key of [...this.rows.keys()]) {
      if (key.startsWith(`${groupId}\u0000`)) {
        this.rows.delete(key);
      }
    }
  }

  public async findAll(): Promise<GroupSetting[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
}

function settingsKey(groupId: string, key: string): string {
  return `${groupId}\u0000${key}`;
}
