import { beforeEach, describe, expect, it } from "vitest";

import { AdminCommandService } from "../../src/services/adminCommands.js";
import { DataMigrationService } from "../../src/services/dataMigration.js";
import {
  auditLog,
  configStore,
  identityMap,
  joinApproval,
  joinAudit,
  joinSync,
  permissions,
} from "../helpers/adminCommandsHarness.js";
import { FakeGroupSettingsRepository } from "../helpers/fakeGroupConfigRepositories.js";
import {
  FakeMigrationActivityDetailsRepository,
  FakeMigrationProfileRepository,
  FakeMigrationShortCodeRepository,
} from "../helpers/fakeMigrationRepositories.js";

/**
 * `/migrate`：全局超管 + 只私信。
 *
 * 预览卡是只读扫描，真正改写走 `cb:migrate:run`（带 modal 二次确认），
 * 执行结果写审计（平台级动作，不挂在任何群上）。
 */
describe("AdminCommandService · /migrate", () => {
  let settings: FakeGroupSettingsRepository;
  let migration: DataMigrationService;
  let service: AdminCommandService;
  let reloads: number;

  function buildService(): AdminCommandService {
    return new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      migrate: migration,
    });
  }

  beforeEach(() => {
    settings = new FakeGroupSettingsRepository();
    reloads = 0;
    migration = new DataMigrationService({
      settings,
      profiles: new FakeMigrationProfileRepository(),
      activityDetails: new FakeMigrationActivityDetailsRepository(),
      shortCodes: new FakeMigrationShortCodeRepository(),
      generateCode: () => "AAA111",
      reload: async () => {
        reloads += 1;
      },
    });
    settings.rows.set("g1\u0000welcomeMessage", {
      groupId: "g1",
      key: "welcomeMessage",
      value: "你好",
    });
    settings.rows.set("g1\u0000keywordPunish", {
      groupId: "g1",
      key: "keywordPunish",
      value: JSON.stringify("kick"),
    });
    service = buildService();
  });

  it("只有全局超管能用", async () => {
    for (const userId of ["admin", "mod", "member"]) {
      const result = await service.handle(undefined, userId, "/migrate");
      expect(result.ok, userId).toBe(false);
      expect(result.text).toContain("只有全局超管");
    }
  });

  it("只能在私信里执行", async () => {
    const result = await service.handle("g1", "root", "/migrate");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("请在私信中执行");
    // 群里被拒绝时不改写任何数据
    expect(localStorage()).toContain("你好");
  });

  it("预览卡只扫描、不改库，并给出确认按钮", async () => {
    const result = await service.handle(undefined, "root", "/migrate");
    expect(result.ok).toBe(true);
    expect(result.rich.markdown).toContain("数据迁移");
    expect(result.rich.markdown).toContain("群配置键值：1 行");
    expect(result.rich.markdown).toContain("违规处理老字段：1 个群");
    // 备份提示与幂等说明
    expect(result.rich.markdown).toContain("备份数据库");
    expect(result.rich.markdown).toContain("幂等");
    // 没有点确认之前一行都没改
    expect(localStorage()).toContain("你好");
    expect(settings.rows.get("g1\u0000punishActions")).toBeUndefined();
    expect(reloads).toBe(0);

    const keyboard = JSON.stringify(result.rich.keyboard);
    // 两步确认：先出确认卡（`cb:migrate:request`），点「确定开始」才 `cb:migrate:run`
    expect(keyboard).toContain("cb:migrate:request");
    expect(keyboard).not.toContain("cb:migrate:run");
    // 不用官方 `modal`（内邀能力）：客户端不认时会把**整块键盘**丢掉，卡上什么按钮都没有
    expect(keyboard).not.toContain("modal");
  });

  it("确认卡：列出条数 + 备份提醒，点「确定开始」才执行", async () => {
    const confirm = await service.migrateConfirmCard("root", undefined);

    expect(confirm.rich.markdown).toContain("确认迁移");
    expect(confirm.rich.markdown).toContain("群配置键值：1 行");
    expect(confirm.rich.markdown).toContain("备份数据库");
    const keyboard = JSON.stringify(confirm.rich.keyboard);
    expect(keyboard).toContain("cb:migrate:run");
    expect(keyboard).toContain("cb:migrate:preview");
    // 确认卡本身还不改库
    expect(localStorage()).toContain("你好");
    expect(reloads).toBe(0);
  });

  it("文本兜底：`/migrate run` 直接执行（按钮没渲染时手输也能走）", async () => {
    const result = await service.handle(undefined, "root", "/migrate run");

    expect(result.rich.markdown).toContain("数据迁移完成");
    expect(settings.rows.get("g1\u0000welcomeMessage")?.value).toBe(
      JSON.stringify("你好"),
    );
  });

  it("没有待迁移项时不提供「开始迁移」按钮", async () => {
    settings.rows.clear();
    const result = await service.handle(undefined, "root", "/migrate");
    expect(result.ok).toBe(true);
    expect(result.rich.markdown).toContain("（无）");
    expect(JSON.stringify(result.rich.keyboard)).not.toContain("cb:migrate:run");
  });

  it("回调 `cb:migrate:run` 才真正改写，并写审计", async () => {
    const result = await service.migrateRunCard("root", undefined);
    expect(result.ok).toBe(true);
    expect(result.rich.markdown).toContain("数据迁移完成");
    expect(result.rich.markdown).toContain("本次改写：");
    expect(reloads).toBe(1);

    // 裸字符串补上 JSON 编码；老处罚键折算成 punishActions 并删掉
    expect(settings.rows.get("g1\u0000welcomeMessage")?.value).toBe(
      JSON.stringify("你好"),
    );
    expect(JSON.parse(settings.rows.get("g1\u0000punishActions")!.value)).toEqual({
      warn: true,
      recall: false,
      mute: false,
      kick: true,
      blacklist: false,
    });
    expect(settings.rows.has("g1\u0000keywordPunish")).toBe(false);

    const records = auditLog.all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      groupId: "",
      actorId: "root",
      action: "data_migrate",
      status: "executed",
    });
    expect(records[0]?.reason).toContain("群配置键值=1");
  });

  it("回调同样只认全局超管与私信", async () => {
    const denied = await service.migrateRunCard("admin", undefined);
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("只有全局超管");

    const inGroup = await service.migrateRunCard("root", "g1");
    expect(inGroup.ok).toBe(false);
    expect(inGroup.text).toContain("请在私信中执行");

    expect(auditLog.all()).toHaveLength(0);
    expect(localStorage()).toContain("你好");
  });

  it("重新扫描确认已经转好", async () => {
    await service.migrateRunCard("root", undefined);
    const again = await service.migrateRefreshCard("root", undefined);
    expect(again.ok).toBe(true);
    expect(again.rich.markdown).toContain("已经是现行格式");
  });

  it("没连接数据库时明确拒绝", async () => {
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      migrate: new DataMigrationService({ generateCode: () => "AAA111" }),
    });
    const result = await service.handle(undefined, "root", "/migrate");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("迁移不可用");
  });

  function localStorage(): string {
    return JSON.stringify([...settings.rows.values()]);
  }
});
