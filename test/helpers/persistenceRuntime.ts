import { loadSettings } from "../../src/config.js";
import type { Queryable } from "../../src/db/queryable.js";
import { createRepositories } from "../../src/persistence.js";
import {
  createRuntime,
  toRuntimeRepositories,
  type Runtime,
} from "../../src/runtime.js";

/**
 * 用真实仓储装配 runtime，生产装配路径的最小测试替身。
 *
 * 仓储**只从 `createRepositories()` 拿**：这里以前是逐个 `new SqlXxxRepository(queryable)`，
 * 漏了 `platformSettings` / `blacklist` / `punishments` / `appeals` / `menuDeliveries` /
 * `privacy` / `adminTokens` 七个 —— 于是集成测试里的 runtime 与生产不是一回事，
 * 真机上「指令明明实现了却报未装配」这类问题测试也照样绿。
 */
export function createPersistentRuntime(
  queryable: Queryable,
  adminUserIds = "root",
): Runtime {
  return createRuntime(loadSettings({ ADMIN_USER_IDS: adminUserIds }), {
    repositories: toRuntimeRepositories(createRepositories(queryable)),
  });
}
