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
import { PlatformSettingsStore } from "../src/services/platformSettings.js";

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
    const store = new PlatformSettingsStore(
      loadSettings({ SCAN_INTERVAL_MS: "60000" }),
      new FakeRepository(),
    );
    await store.load();
    await store.set("scanIntervalMs", "30000");

    const view = buildSettingsView(store, {});
    const scan = view.settings.find((item) => item.key === "scanIntervalMs");

    expect(scan).toMatchObject({
      key: "scanIntervalMs",
      envKey: "SCAN_INTERVAL_MS",
      value: 30_000,
      source: "override",
    });
    expect(scan?.display).toContain("30000");
    // 没改过的项来源是 env
    const retention = view.settings.find(
      (item) => item.key === "auditLogRetentionDays",
    );
    expect(retention?.source).toBe("env");
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
 */
describe("配置项覆盖（漂移守卫）", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  it("src/config.ts 与 adminApi/config.ts 读的 env 键都出现在 ENV_LABELS 里", () => {
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

    expect(keys.size).toBeGreaterThan(20);
    const missing = [...keys].filter((key) => ENV_LABELS[key] === undefined).sort();
    expect(missing, `这些 env 键没出现在配置页：${missing.join(", ")}`).toEqual([]);
  });
});
