import { beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config.js";
import type {
  PlatformSetting,
  PlatformSettingsRepository,
} from "../../src/db/platformSettingsRepository.js";
import { AdminCommandService } from "../../src/services/adminCommands.js";
import { PlatformSettingsStore } from "../../src/services/platformSettings.js";
import {
  auditLog,
  configStore,
  identityMap,
  joinApproval,
  joinAudit,
  joinSync,
  permissions,
} from "../helpers/adminCommandsHarness.js";

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

/**
 * P1：`/config` 热改平台配置 —— 只有全局超管、只在私信；改完立即生效，每次改动写审计。
 */
describe("AdminCommandService · /config", () => {
  let repository: FakePlatformSettingsRepository;
  let platform: PlatformSettingsStore;
  let service: AdminCommandService;

  beforeEach(async () => {
    repository = new FakePlatformSettingsRepository();
    platform = new PlatformSettingsStore(loadSettings({}), repository);
    await platform.load();
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      platform,
    });
  });

  it("只有全局超管能用", async () => {
    for (const userId of ["member", "mod", "admin"]) {
      const result = await service.handle(undefined, userId, "/config");
      expect(result.ok, userId).toBe(false);
      expect(result.text).toContain("只有全局超管");
    }
  });

  it("只能在私信里用", async () => {
    const result = await service.handle("g1", "root", "/config");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("只能在私信里");
  });

  it("面板列出各项的当前值与来源，并按键盘上限分页", async () => {
    const first = await service.handle(undefined, "root", "/config");
    expect(first.ok).toBe(true);
    expect(first.rich.markdown).toContain("平台配置（1/2）");
    expect(first.rich.markdown).toContain("扫描周期");
    expect(first.rich.markdown).toContain("`.env` 默认");
    expect(JSON.stringify(first.rich.keyboard)).toContain("cb:config:view:2");
    // 每项一个「填入指令」按钮
    expect(JSON.stringify(first.rich.keyboard)).toContain("/config set scanIntervalMs ");

    const second = await service.configPanelCard("root", 2);
    expect(second.rich.markdown).toContain("平台配置（2/2）");
    expect(second.rich.markdown).toContain("展示时区");
  });

  it("改一项：立即生效 + 写库 + 记审计 + 面板显示已覆盖", async () => {
    const changed = await service.handle(
      undefined,
      "root",
      "/config set scanIntervalMs 120000",
    );
    expect(changed.ok, changed.text).toBe(true);
    expect(platform.get("scanIntervalMs")).toBe(120_000);
    await platform.flush();
    expect(repository.rows.get("scanIntervalMs")).toBe("120000");
    expect(changed.rich.markdown).toContain("立即生效");
    expect(changed.rich.markdown).toContain("已覆盖");

    const records = auditLog.all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      groupId: "",
      actorId: "root",
      action: "platform_config_set",
      reason: "scanIntervalMs=120000",
    });
  });

  it("非法值被拒：不改库、不写审计", async () => {
    const bad = await service.handle(
      undefined,
      "root",
      "/config set scanIntervalMs 很多",
    );
    expect(bad.ok).toBe(false);
    expect(platform.get("scanIntervalMs")).toBe(60_000);
    expect(repository.rows.size).toBe(0);
    expect(auditLog.all()).toHaveLength(0);

    const unknown = await service.handle(undefined, "root", "/config set nope 1");
    expect(unknown.ok).toBe(false);
    expect(unknown.rich.markdown).toContain("没有叫");
  });

  it("clear 回落到 .env 默认并记审计", async () => {
    await service.handle(undefined, "root", "/config set appealHoldMinutes 30");
    const cleared = await service.handle(
      undefined,
      "root",
      "/config clear appealHoldMinutes",
    );

    expect(cleared.ok).toBe(true);
    expect(platform.get("appealHoldMinutes")).toBe(
      loadSettings({}).appealHoldMinutes,
    );
    await platform.flush();
    expect(repository.rows.has("appealHoldMinutes")).toBe(false);
    expect(auditLog.all().map((record) => record.action)).toEqual([
      "platform_config_set",
      "platform_config_clear",
    ]);
  });

  it("用法不对时回面板并提示，不改任何东西", async () => {
    const typo = await service.handle(undefined, "root", "/config set");
    expect(typo.rich.markdown).toContain("要写清改哪一项");
    const unknownAction = await service.handle(undefined, "root", "/config 删除");
    expect(unknownAction.rich.markdown).toContain("未识别的动作");
    expect(repository.rows.size).toBe(0);
  });

  it("没装配平台配置存储时明确拒绝", async () => {
    const bare = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
    });
    const result = await bare.handle(undefined, "root", "/config");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("没有装配平台配置存储");
  });
});
