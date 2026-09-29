import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import type {
  PlatformSetting,
  PlatformSettingsRepository,
} from "../src/db/platformSettingsRepository.js";
import {
  PlatformSettingsStore,
  SETTING_DEFINITIONS,
  findDefinition,
} from "../src/services/platformSettings.js";

class FakePlatformSettingsRepository implements PlatformSettingsRepository {
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

function harness(): {
  repository: FakePlatformSettingsRepository;
  store: PlatformSettingsStore;
} {
  const repository = new FakePlatformSettingsRepository();
  const store = new PlatformSettingsStore(loadSettings({}), repository);
  return { repository, store };
}

/**
 * P1：非核心 `.env` 配置项改成超管可热改 —— 数据库覆盖 > `.env` 默认，
 * 服务在用的时候读 `get()`，所以改完立即生效。
 */
describe("PlatformSettingsStore", () => {
  it("默认取 .env 的值，来源标成 env", async () => {
    const { store } = harness();
    await store.load();

    expect(store.get("scanIntervalMs")).toBe(60_000);
    expect(store.get("auditLogRetentionDays")).toBe(180);
    expect(store.sourceOf("scanIntervalMs")).toBe("env");
    expect(store.list().every((view) => view.source === "env")).toBe(true);
  });

  it("改一项：立即生效 + 落库 + 来源变 override", async () => {
    const { store, repository } = harness();
    const result = await store.set("scanIntervalMs", "120000");

    expect(result.ok).toBe(true);
    expect(store.get("scanIntervalMs")).toBe(120_000);
    expect(store.sourceOf("scanIntervalMs")).toBe("override");
    await store.flush();
    expect(repository.rows.get("scanIntervalMs")).toBe("120000");
  });

  it("重启后从库里读回覆盖值（未覆盖项仍取 .env）", async () => {
    const { store, repository } = harness();
    await store.set("autoRestartOnDeploy", "关");
    await store.flush();

    const restarted = new PlatformSettingsStore(loadSettings({}), repository);
    await restarted.load();

    expect(restarted.get("autoRestartOnDeploy")).toBe(false);
    expect(restarted.sourceOf("autoRestartOnDeploy")).toBe("override");
    expect(restarted.get("scanIntervalMs")).toBe(60_000);
    expect(restarted.sourceOf("scanIntervalMs")).toBe("env");
  });

  it("clear 回落到 .env 并删掉库里的行", async () => {
    const { store, repository } = harness();
    await store.set("appealHoldMinutes", "30");
    await store.flush();
    expect(store.get("appealHoldMinutes")).toBe(30);

    const cleared = await store.clear("appealHoldMinutes");
    await store.flush();

    expect(cleared.ok).toBe(true);
    expect(store.get("appealHoldMinutes")).toBe(loadSettings({}).appealHoldMinutes);
    expect(store.sourceOf("appealHoldMinutes")).toBe("env");
    expect(repository.rows.has("appealHoldMinutes")).toBe(false);
    // 再清一次是幂等的
    expect((await store.clear("appealHoldMinutes")).ok).toBe(true);
  });

  it("非法值被拒：不改内存、不写库", async () => {
    const { store, repository } = harness();
    await store.load();
    for (const raw of ["abc", "-5", "99999999"]) {
      const result = await store.set("scanIntervalMs", raw);
      expect(result.ok, raw).toBe(false);
    }
    expect(store.get("scanIntervalMs")).toBe(60_000);
    expect(repository.rows.size).toBe(0);

    const unknown = await store.set("nope", "1");
    expect(unknown.ok).toBe(false);
  });

  it("布尔 / 枚举 / 时区 / URL 各自校验", async () => {
    const { store } = harness();
    expect((await store.set("autoRestartOnDeploy", "开")).ok).toBe(true);
    expect(store.get("autoRestartOnDeploy")).toBe(true);
    expect((await store.set("autoRestartOnDeploy", "也许")).ok).toBe(false);

    expect((await store.set("menuFirstPush", "persistent")).ok).toBe(true);
    expect(store.get("menuFirstPush")).toBe("persistent");
    expect((await store.set("menuFirstPush", "sometimes")).ok).toBe(false);

    expect((await store.set("displayTimezone", "Asia/Shanghai")).ok).toBe(true);
    expect(store.get("displayTimezone")).toBe("Asia/Shanghai");
    expect((await store.set("displayTimezone", "Mars/Olympus")).ok).toBe(false);

    expect((await store.set("activityStatsFontUrl", "")).ok).toBe(true);
    expect((await store.set("activityStatsFontUrl", "ftp://x")).ok).toBe(false);
    expect((await store.set("activityStatsFontUrl", "https://x/y.ttf")).ok).toBe(true);
  });

  it("库里的坏值 / 未知键只跳过并记进 issues（不让启动失败）", async () => {
    const { store, repository } = harness();
    repository.rows.set("scanIntervalMs", "{不是 JSON");
    repository.rows.set("notASetting", "1");
    repository.rows.set("auditLogRetentionDays", JSON.stringify(45));

    await store.load();

    expect(store.get("scanIntervalMs")).toBe(60_000);
    expect(store.sourceOf("scanIntervalMs")).toBe("env");
    expect(store.get("auditLogRetentionDays")).toBe(45);
    expect(store.issues.join("\n")).toContain("扫描周期");
    expect(store.issues.join("\n")).toContain("notASetting");
  });

  it("改动能通知到需要主动生效的项", async () => {
    const { store } = harness();
    const changed: string[] = [];
    store.onChange((key) => changed.push(key));

    await store.set("appealHoldMinutes", "20");
    await store.clear("appealHoldMinutes");

    expect(changed).toEqual(["appealHoldMinutes", "appealHoldMinutes"]);
  });

  it("面板列出全部可热改项，且每项都有定义与展示文案", async () => {
    const { store } = harness();
    await store.load();
    const views = store.list();

    expect(views).toHaveLength(SETTING_DEFINITIONS.length);
    expect(views.length).toBeGreaterThanOrEqual(13);
    for (const view of views) {
      expect(view.definition.label.length).toBeGreaterThan(0);
      expect(view.definition.envKey.length).toBeGreaterThan(0);
      expect(view.definition.describe(view.value).length).toBeGreaterThan(0);
    }
    expect(findDefinition("deployRestartDelayMinutes")?.envKey).toBe(
      "DEPLOY_RESTART_DELAY_MINUTES",
    );
    expect(findDefinition("nope")).toBeUndefined();
  });

  it("保留期的展示文案区分 永久 / 关闭 / N 天", () => {
    const definition = findDefinition("auditLogRetentionDays");
    expect(definition?.describe(-1)).toBe("永久保留");
    expect(definition?.describe(0)).toBe("关闭（不保留 / 不清理）");
    expect(definition?.describe(30)).toBe("30 天");
  });

  it("没有数据库时也能用（纯内存模式）", async () => {
    const store = new PlatformSettingsStore(loadSettings({}));
    await store.load();
    expect((await store.set("scanIntervalMs", "5000")).ok).toBe(true);
    expect(store.get("scanIntervalMs")).toBe(5000);
  });
});
