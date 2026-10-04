import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import type {
  PlatformSetting,
  PlatformSettingsRepository,
} from "../src/db/platformSettingsRepository.js";
import {
  ENV_LABELS,
  buildEnvItems,
  buildSettingsView,
  isSecretEnvKey,
} from "../src/adminApi/settings.js";
import {
  PlatformSettingsStore,
  SETTING_DEFINITIONS,
} from "../src/services/platformSettings.js";

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

/**
 * 管理后台的「配置」视图（E2-f）。
 *
 * 两条口径：可改的只有既有的热改项（走 `/config` 同一套存储）；`.env` 其余项只读展示，
 * 而且**密钥类不回传值** —— 浏览器只需要知道「配没配」。
 */
describe("buildEnvItems", () => {
  it("非敏感键给值，密钥类只给「配没配」", () => {
    const items = buildEnvItems({
      EVENT_MODE: "webhook",
      WEBHOOK_PORT: "8786",
      QQ_BOT_CLIENT_SECRET: "super-secret",
      QQ_BOT_TOKEN: "also-secret",
      ADMIN_API_SESSION_SECRET: "s3cret",
      ADMIN_API_TOKENS: "machine-token",
    });
    const byKey = new Map(items.map((item) => [item.key, item]));

    expect(byKey.get("EVENT_MODE")).toMatchObject({
      value: "webhook",
      configured: true,
      secret: false,
    });
    expect(byKey.get("WEBHOOK_PORT")?.value).toBe("8786");
    // 密钥类：有值也必须隐去
    for (const key of [
      "QQ_BOT_CLIENT_SECRET",
      "QQ_BOT_TOKEN",
      "ADMIN_API_SESSION_SECRET",
      "ADMIN_API_TOKENS",
    ]) {
      const item = byKey.get(key);
      expect(item?.secret, key).toBe(true);
      expect(item?.configured, key).toBe(true);
      expect(item?.value, key).toBeUndefined();
    }
  });

  it("没配置的项 configured=false（空串也算没配）", () => {
    const items = buildEnvItems({ EVENT_MODE: "", WEBHOOK_PORT: "   " });
    const byKey = new Map(items.map((item) => [item.key, item]));

    expect(byKey.get("EVENT_MODE")?.configured).toBe(false);
    expect(byKey.get("EVENT_MODE")?.value).toBeUndefined();
    expect(byKey.get("WEBHOOK_PORT")?.configured).toBe(false);
    expect(byKey.get("QQ_BOT_APP_ID")?.configured).toBe(false);
  });

  it("热改项不在只读段重复出现（ADR-0066 后只读段只剩核心项）", () => {
    // 进程环境里把所有热改项的 env 键都塞上值，只读段也一个都不该出现
    const env: NodeJS.ProcessEnv = {};
    for (const definition of SETTING_DEFINITIONS) {
      env[definition.envKey] = "1";
    }
    const keys = new Set(buildEnvItems(env).map((item) => item.key));
    for (const definition of SETTING_DEFINITIONS) {
      expect(keys.has(definition.envKey), definition.envKey).toBe(false);
    }
    // 真正留在 `.env` 里的核心项还在（密钥类也在，只是不回传值）
    expect(keys.has("EVENT_MODE")).toBe(true);
    expect(keys.has("ADMIN_API_SESSION_SECRET")).toBe(true);
  });

  it("密钥判据：SECRET / TOKEN / PASSWORD / *_KEY 都算", () => {
    expect(isSecretEnvKey("QQ_BOT_CLIENT_SECRET")).toBe(true);
    expect(isSecretEnvKey("QQ_BOT_TOKEN")).toBe(true);
    expect(isSecretEnvKey("WEBHOOK_SECRET")).toBe(true);
    expect(isSecretEnvKey("ADMIN_API_SESSION_SECRET")).toBe(true);
    expect(isSecretEnvKey("EVENT_MODE")).toBe(false);
    expect(isSecretEnvKey("WEBHOOK_PORT")).toBe(false);
  });
});

describe("buildSettingsView", () => {
  it("可改项给出生效值、来源与给人看的一行", async () => {
    const store = new PlatformSettingsStore(loadSettings({}), new FakeRepository());
    await store.load();
    await store.set("scanIntervalMs", "30000");

    const view = buildSettingsView(store, {});
    const scan = view.settings.find((item) => item.key === "scanIntervalMs");

    expect(scan).toMatchObject({
      key: "scanIntervalMs",
      envKey: "SCAN_INTERVAL_MS",
      value: 30_000,
      source: "override",
      envBacked: false,
    });
    expect(scan?.display).toContain("30000");
    // 没改过的项来源是 env（= 启动默认值）
    const retention = view.settings.find(
      (item) => item.key === "auditLogRetentionDays",
    );
    expect(retention?.source).toBe("env");
    // `TZ` 是唯一「默认值真的来自 .env」的核心项，前端据 envBacked 区分文案
    const timezone = view.settings.find((item) => item.key === "displayTimezone");
    expect(timezone?.envBacked).toBe(true);
    // `.env` 只读项与热改项一起给出来（页面分两段展示）
    expect(view.env.length).toBeGreaterThan(0);
    expect(view.issues).toEqual([]);
  });
});

/**
 * 漂移守卫：`config.ts` 里读的每个 `env.X` 都必须在配置页出现过。
 *
 * 为什么值得守：新增配置项时最容易漏的就是「忘了把它挂到管理后台」，而漏了以后
 * 运维只能登服务器看 `.env`。这里用源码扫描把「读过的键」与「展示过的键」钉在一起。
 *
 * ADR-0066 之后多了一条路：热改项**不再被 `config.ts` 读到**，它们在配置页的「可改项」
 * 那一段显示（带各自的 `envKey`）。所以守卫要看两个来源：
 * `env.X` 读取点 ∪ `SETTING_DEFINITIONS[].envKey`，两边都必须能在配置页找到。
 */
describe("配置项覆盖（漂移守卫）", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  it("config.ts / adminApi-config.ts 读的 env 键与所有热改项的 envKey 都出现在配置页", () => {
    const sources = [
      readFileSync(`${ROOT}src/config.ts`, "utf8"),
      readFileSync(`${ROOT}src/adminApi/config.ts`, "utf8"),
    ];
    const keys = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/env\.([A-Z][A-Z0-9_]*)/gu)) {
        if (match[1] !== undefined) {
          keys.add(match[1]);
        }
      }
    }
    for (const definition of SETTING_DEFINITIONS) {
      keys.add(definition.envKey);
    }

    expect(keys.size).toBeGreaterThan(20);
    const missing = [...keys]
      .filter(
        (key) =>
          ENV_LABELS[key] === undefined &&
          SETTING_DEFINITIONS.find((definition) => definition.envKey === key) ===
            undefined,
      )
      .sort();
    expect(missing, `这些 env 键没出现在配置页：${missing.join(", ")}`).toEqual([]);
  });
});
