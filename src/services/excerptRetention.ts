import { DEFAULT_GROUP_ID, type GroupConfigStore } from "./groupConfig.js";
import type { PlatformSettingsStore } from "./platformSettings.js";

/**
 * 处罚**消息原文**保留期的取值口径（§B7）。
 *
 * 原文保留期是**按群**的：群自己 `> 0` 就按群的天数清、`-1` 永久、`0` 不存；
 * 群**没显式设过**时用平台默认值（`/config` 里的 `rawMessageRetentionDays`）。
 *
 * 关键点：显式设置包括**全局默认规则**（`/rules set all ...`）—— 那是所有群的默认，
 * 不该被平台默认值盖掉。返回值 `<= 0` 都表示「不清」（`0` 没存、`-1` 永久）。
 */
export function rawMessageDaysResolver(
  configStore: GroupConfigStore,
  platform: PlatformSettingsStore,
): (groupId: string) => number {
  const globalOverride = (): boolean =>
    configStore
      .overriddenFields(DEFAULT_GROUP_ID)
      .has("rawMessageRetentionDays");
  return (groupId: string): number => {
    const explicit =
      globalOverride() ||
      configStore
        .overriddenFields(groupId)
        .has("rawMessageRetentionDays");
    return explicit
      ? configStore.get(groupId).rawMessageRetentionDays
      : platform.get("rawMessageRetentionDays");
  };
}
