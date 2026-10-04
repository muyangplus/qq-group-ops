import type { HotSettingKey, PlatformSettingsStore } from "./platformSettings.js";
import { IMPORTED_FROM_ENV_KEYS, definitionOf } from "./platformSettings.js";

/**
 * `.env` 里热改项的**一次性导入**（ADR-0066）。
 *
 * 背景：这些项以前是「`.env` 提供默认值、库覆盖优先」。为了让 `.env` 只留
 * 「密钥 / 引导 / 进程与网络 / 日志 / 路径」，默认值已经搬进代码（`DEFAULT_*`），
 * `.env` 不再参与运行期取值 —— 但**不能让老部署的行为悄悄漂移**：
 * 启动时把 `.env` 里写过的项**写库一次**，此后一切以库为准，`.env` 里删掉这些行也没有影响。
 *
 * 口径（逐条可测）：
 * - 只认「`.env` / 进程环境里**存在**」的键：`undefined` 直接跳过；
 * - 值为**空串**且这一项不接受空值（整数 / 布尔）时视为「没填」，按老行为回落内置默认
 *   （老实现 `asInt` / `asBool` 对空串都是「返回 fallback」，而 fallback 就是同一个内置默认值）；
 * - 库里**已经有覆盖行**时以库为准（`.env` 不再有任何影响）；
 * - 值不合法只记进 `problems`，**不影响启动**（老行为里布尔项是「静默当成 false」，
 *   现在至少会报出来 + 提醒一次）；
 * - 值与内置默认相同时**不写库**（行为本来一致，写进去只会平白多一行覆盖记录）；
 * - 真的写库之后**留一条「已导入」的痕**（`store.markImportedFromEnv`）：迁移因此**真的只做一次** ——
 *   用户之后 `/config clear` 回内置默认，不会被下一次启动又导回来；
 * - 迁移本身**不在这里写审计 / 通知**：那是接线层（`main.ts`）的事。
 */

/** 系统动作的审计 actor（占位符，不是真实用户；与 `deploy-watcher` 同一口径）。 */
export const ENV_IMPORT_ACTOR = "env-import";

export interface ImportedSetting {
  key: HotSettingKey;
  envKey: string;
  label: string;
  /** `.env` 里的原文（已 trim），便于审计里对得上。 */
  raw: string;
  /** 落库后的值。 */
  value: number | boolean | string;
}

export interface SettingsImportResult {
  /** 真的写进库的项。 */
  imported: ImportedSetting[];
  /** 之前已经导入过（有留痕）：`.env` 里这一项再改都不会生效。 */
  alreadyImported: string[];
  /** `.env` 里写了、但值就是内置默认值：不写库（生效行为本来就一致）。 */
  sameAsDefault: string[];
  /** 库里已有覆盖行：以库为准，`.env` 的这一项被忽略。 */
  overridden: string[];
  /** `.env` 里写了但值不合法：跳过并报告。 */
  problems: string[];
}

export interface SettingsImportOptions {
  store: PlatformSettingsStore;
  /** 迁移来源；默认 `process.env`（含 `loadEnvFile()` 载入的 `.env` 值）。 */
  env?: NodeJS.ProcessEnv | undefined;
}

export async function importEnvSettingsToStore(
  options: SettingsImportOptions,
): Promise<SettingsImportResult> {
  const env = options.env ?? process.env;
  const result: SettingsImportResult = {
    imported: [],
    alreadyImported: [],
    sameAsDefault: [],
    overridden: [],
    problems: [],
  };

  for (const key of IMPORTED_FROM_ENV_KEYS) {
    const definition = definitionOf(key);
    const raw = env[definition.envKey];
    if (raw === undefined) {
      // `.env` 里没写这一项（也含进程环境没设）
      continue;
    }
    // 已经导入过：`.env` 里这一项从此是死配置 —— 哪怕值是坏的、哪怕用户刚 `/config clear` 过
    if (options.store.wasImportedFromEnv(key)) {
      result.alreadyImported.push(definition.envKey);
      continue;
    }
    const trimmed = raw.trim();
    // 库里已经有覆盖行（用户在 `/config` / 后台改过）：以库为准
    if (options.store.sourceOf(key) === "override") {
      result.overridden.push(definition.envKey);
      continue;
    }
    const parsed = definition.parse(trimmed);
    if (!parsed.ok) {
      // 空串 = 「没填」：老行为就是回落内置默认（`asInt` / `asBool` 对空串返回 fallback），
      // 不该当成配置错误刷日志
      if (trimmed.length === 0) {
        continue;
      }
      result.problems.push(`${definition.label}（${definition.envKey}）：${parsed.error}`);
      continue;
    }
    if (options.store.valueOf(key) === parsed.value) {
      result.sameAsDefault.push(definition.envKey);
      continue;
    }
    // `set()` 里用的是同一份 `parse`（上面刚校验过），所以这里不会失败；留一条兜底免得静默丢项
    const applied = await options.store.set(key, trimmed);
    if (!applied.ok) {
      result.problems.push(`${definition.label}（${definition.envKey}）：${applied.error}`);
      continue;
    }
    // 留痕：只写一次（`clear()` 不动它），这样「迁移只做一次」才成立
    await options.store.markImportedFromEnv(key, trimmed);
    result.imported.push({
      key,
      envKey: definition.envKey,
      label: definition.label,
      raw: trimmed,
      value: parsed.value,
    });
  }

  // 导入是启动路径：落库失败（写队列里的错误）不能拦启动，但必须刷完再往下走
  await options.store.flush();
  return result;
}

/** 有没有真的改到什么（供接线层决定要不要通知 / 记审计）。 */
export function hasImportedSettings(result: SettingsImportResult): boolean {
  return result.imported.length > 0 || result.problems.length > 0;
}
