import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import type {
  PlatformSetting,
  PlatformSettingsRepository,
} from "../src/db/platformSettingsRepository.js";
import { PlatformSettingsStore, SETTING_DEFINITIONS } from "../src/services/platformSettings.js";
import {
  hasImportedSettings,
  importEnvSettingsToStore,
} from "../src/services/settingsImport.js";

/**
 * ADR-0066：`.env` 里的热改项在启动时**一次性导入** `platform_settings` 表。
 *
 * 目标只有一个：**升级瞬间行为不漂移** —— 老部署写在 `.env` 里的值照样生效，
 * 之后一切以库为准（`.env` 里删掉这些行没有任何影响）。
 */
class FakeRepository implements PlatformSettingsRepository {
  public readonly rows = new Map<string, string>();

  public async findAll(): Promise<PlatformSetting[]> {
    return [...this.rows.entries()].map(([key, value]) => ({ key, value }));
  }

  public async save(setting: PlatformSetting): Promise<void> {
    this.rows.set(setting.key, setting.value);
  }

  public async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

async function makeStore(): Promise<{
  repository: FakeRepository;
  store: PlatformSettingsStore;
}> {
  const repository = new FakeRepository();
  const store = new PlatformSettingsStore(loadSettings({}), repository);
  await store.load();
  return { repository, store };
}

describe("importEnvSettingsToStore", () => {
  it("把与内置默认不同的项写库一次，并留痕（第二次以库为准）", async () => {
    const { repository, store } = await makeStore();
    const result = await importEnvSettingsToStore({
      store,
      env: {
        RAW_MESSAGE_RETENTION_DAYS: "7",
        SCAN_INTERVAL_MS: "120000",
        MENU_FIRST_PUSH: "mem", // 老别名也要认：否则升级时行为会漂移
        ADMIN_API_TOKEN_TTL_MINUTES: "3",
      },
    });

    expect(result.imported.map((item) => item.envKey).sort()).toEqual([
      "ADMIN_API_TOKEN_TTL_MINUTES",
      "MENU_FIRST_PUSH",
      "RAW_MESSAGE_RETENTION_DAYS",
      "SCAN_INTERVAL_MS",
    ]);
    expect(result.problems).toEqual([]);
    expect(result.sameAsDefault).toEqual([]);
    expect(hasImportedSettings(result)).toBe(true);

    // 生效值 + 来源 + 真的落库了
    expect(store.get("rawMessageRetentionDays")).toBe(7);
    expect(store.get("menuFirstPush")).toBe("memory");
    expect(store.sourceOf("rawMessageRetentionDays")).toBe("override");
    expect(repository.rows.get("rawMessageRetentionDays")).toBe("7");
    // 每一项都留了「已导入」的痕（与覆盖行分开记）
    expect(repository.rows.has("__env_import__:rawMessageRetentionDays")).toBe(
      true,
    );
    expect(store.wasImportedFromEnv("rawMessageRetentionDays")).toBe(true);

    // 第二次启动：留痕在 → `.env`（哪怕改了值）不再有任何影响
    const again = await importEnvSettingsToStore({
      store,
      env: { RAW_MESSAGE_RETENTION_DAYS: "9", SCAN_INTERVAL_MS: "120000" },
    });
    expect(again.imported).toEqual([]);
    expect(again.alreadyImported.sort()).toEqual([
      "RAW_MESSAGE_RETENTION_DAYS",
      "SCAN_INTERVAL_MS",
    ]);
    expect(store.get("rawMessageRetentionDays")).toBe(7);
    expect(hasImportedSettings(again)).toBe(false);
  });

  /**
   * 回归（审查时实测出来的坑）：判断「迁移做过没有」**不能**看「库里有没有覆盖行」——
   * 那样 `/config clear`（删掉覆盖行）之后，下一次启动会把 `.env` 里的旧值又导回来，
   * 「回内置默认」就只在本次进程内成立，与面板文案 / `.env.example` 的说法矛盾。
   */
  it("导入过之后 `/config clear` 回内置默认，重启不会被 `.env` 导回来", async () => {
    const repository = new FakeRepository();
    const env = { SCAN_INTERVAL_MS: "120000" };

    // 第一次启动：导入 → 覆盖值 120000
    const first = new PlatformSettingsStore(loadSettings({}), repository);
    await first.load();
    expect(
      (await importEnvSettingsToStore({ store: first, env })).imported.map(
        (item) => item.envKey,
      ),
    ).toEqual(["SCAN_INTERVAL_MS"]);
    expect(first.get("scanIntervalMs")).toBe(120_000);

    // 全局超管 `/config clear scanIntervalMs`（= 后台「恢复默认」）→ 回内置默认
    expect((await first.clear("scanIntervalMs")).ok).toBe(true);
    await first.flush();
    expect(first.get("scanIntervalMs")).toBe(60_000);
    expect(repository.rows.has("scanIntervalMs")).toBe(false);

    // 重启（模拟：同一份库、新的 store）→ 留痕还在 → `.env` 不再被导回来
    const restarted = new PlatformSettingsStore(loadSettings({}), repository);
    await restarted.load();
    expect(restarted.wasImportedFromEnv("scanIntervalMs")).toBe(true);
    const second = await importEnvSettingsToStore({ store: restarted, env });
    expect(second.imported).toEqual([]);
    expect(second.alreadyImported).toEqual(["SCAN_INTERVAL_MS"]);
    expect(restarted.get("scanIntervalMs")).toBe(60_000);
    // `/config` 面板不会把留痕当成配置项或坏值
    expect(restarted.list().some((view) => view.definition.key === "scanIntervalMs")).toBe(
      true,
    );
    expect(restarted.issues).toEqual([]);
    expect(restarted.sourceOf("scanIntervalMs")).toBe("env");
  });

  it("留痕不进 list() / issues：它只是「导入过」的事实记录", async () => {
    const repository = new FakeRepository();
    const store = new PlatformSettingsStore(loadSettings({}), repository);
    await store.load();
    await store.set("scanIntervalMs", "5000");
    await store.markImportedFromEnv("scanIntervalMs", "5000");
    await store.flush();

    const reloaded = new PlatformSettingsStore(loadSettings({}), repository);
    await reloaded.load();
    expect(reloaded.issues).toEqual([]);
    // 面板只列定义表里的项：留痕不占位、也不冒充配置项
    expect(reloaded.list()).toHaveLength(SETTING_DEFINITIONS.length);
    expect(reloaded.get("scanIntervalMs")).toBe(5000);
  });

  it("库里有覆盖行（升级前就用 `/config` 改过）→ 忽略 `.env`，且不留痕", async () => {
    const { repository, store } = await makeStore();
    await store.set("rawMessageRetentionDays", "3");
    await store.flush();

    const result = await importEnvSettingsToStore({
      store,
      env: { RAW_MESSAGE_RETENTION_DAYS: "7" },
    });
    expect(result.imported).toEqual([]);
    expect(result.overridden).toEqual(["RAW_MESSAGE_RETENTION_DAYS"]);
    expect(store.get("rawMessageRetentionDays")).toBe(3);
    // 没有留痕：万一用户删掉覆盖行，`.env` 那一行仍然应该能生效（它从来没被导入过）
    expect(store.wasImportedFromEnv("rawMessageRetentionDays")).toBe(false);
    expect(repository.rows.has("__env_import__:rawMessageRetentionDays")).toBe(
      false,
    );
  });

  it("与内置默认相同的项不写库（行为本来就一致）", async () => {
    const { repository, store } = await makeStore();
    const result = await importEnvSettingsToStore({
      store,
      env: { SCAN_INTERVAL_MS: "60000", SCHEDULED_ANNOUNCE_ENABLED: "0" },
    });

    expect(result.imported).toEqual([]);
    expect(result.sameAsDefault.sort()).toEqual([
      "SCAN_INTERVAL_MS",
      "SCHEDULED_ANNOUNCE_ENABLED",
    ]);
    expect(repository.rows.size).toBe(0);
    // 没有覆盖行 → 来源仍然是启动默认值
    expect(store.sourceOf("scanIntervalMs")).toBe("env");
    expect(hasImportedSettings(result)).toBe(false);
  });

  it("坏值只记进 problems（不影响启动），空串按「没填」处理", async () => {
    const { repository, store } = await makeStore();
    const result = await importEnvSettingsToStore({
      store,
      env: {
        SCHEDULED_ANNOUNCE_ENABLED: "maybe", // 布尔项写错
        SCAN_INTERVAL_MS: "  ", // 空串 = 没填（老行为就是回落默认）
        DEPLOY_CHECK_INTERVAL_MS: "1e9", // 不是整数
      },
    });

    expect(result.imported).toEqual([]);
    expect(result.problems).toHaveLength(2);
    expect(result.problems.join("\n")).toContain("SCHEDULED_ANNOUNCE_ENABLED");
    expect(result.problems.join("\n")).toContain("DEPLOY_CHECK_INTERVAL_MS");
    expect(repository.rows.size).toBe(0);
    // 坏值不写库也不留痕：生效值仍是内置默认，`.env` 修好之后下次启动会重新导入
    expect(store.get("scheduledAnnounceEnabled")).toBe(false);
    expect(store.wasImportedFromEnv("scheduledAnnounceEnabled")).toBe(false);
    expect(hasImportedSettings(result)).toBe(true);
  });

  /**
   * 空串的语义要与 ADR-0066 之前的实现**逐项对齐**：老 `asInt` / `asBool` 对空串都是
   * 「返回 fallback」，而 fallback 就是同一个内置默认值。所以 `AUTO_RESTART_ON_DEPLOY=`
   * 不能变成「关」—— 它的内置默认是「开」。
   */
  it("空串 = 没填 = 内置默认（布尔项也一样：AUTO_RESTART_ON_DEPLOY= 不等于关）", async () => {
    const { repository, store } = await makeStore();
    const result = await importEnvSettingsToStore({
      store,
      env: { AUTO_RESTART_ON_DEPLOY: "", SCHEDULED_ANNOUNCE_ENABLED: "   " },
    });

    expect(result.imported).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.sameAsDefault).toEqual([]);
    expect(repository.rows.size).toBe(0);
    expect(store.get("autoRestartOnDeploy")).toBe(true);
    expect(store.get("scheduledAnnounceEnabled")).toBe(false);
  });

  it("显式空值的文本项照常导入（`ACTIVITY_STATS_FONT_URL=` 表示只用系统字体）", async () => {
    const { repository, store } = await makeStore();
    const result = await importEnvSettingsToStore({
      store,
      env: { ACTIVITY_STATS_FONT_URL: "" },
    });

    expect(result.imported.map((item) => item.envKey)).toEqual([
      "ACTIVITY_STATS_FONT_URL",
    ]);
    expect(store.get("activityStatsFontUrl")).toBe("");
    expect(repository.rows.get("activityStatsFontUrl")).toBe('""');
  });

  it("不碰还留在 `.env` 的核心项（TZ）与没写进 `.env` 的项", async () => {
    const { repository, store } = await makeStore();
    const result = await importEnvSettingsToStore({
      store,
      env: { TZ: "America/New_York" },
    });

    expect(result.imported).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(repository.rows.size).toBe(0);
    // `TZ` 是 `loadSettings` 的活（envBacked），不是导入器的活
    expect(store.get("displayTimezone")).toBe("Asia/Shanghai");
  });

  it("纯内存模式（没有仓储）也能导入：只作用于本进程", async () => {
    const store = new PlatformSettingsStore(loadSettings({}));
    await store.load();
    expect(store.persistent).toBe(false);

    const result = await importEnvSettingsToStore({
      store,
      env: { APPEAL_HOLD_MINUTES: "30" },
    });

    expect(result.imported.map((item) => item.envKey)).toEqual([
      "APPEAL_HOLD_MINUTES",
    ]);
    expect(store.get("appealHoldMinutes")).toBe(30);
    expect(store.wasImportedFromEnv("appealHoldMinutes")).toBe(true);
  });
});
