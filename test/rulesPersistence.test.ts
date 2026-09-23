import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { JoinDecisionMode, KeywordPunish } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { AuditLogStore } from "../src/services/audit.js";
import {
  DEFAULT_GROUP_ID,
  GroupConfigStore,
} from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";
import { PermissionService } from "../src/services/permissions.js";
import {
  FakeGroupConfigRepository,
  FakeGroupSettingsRepository,
} from "./helpers/fakeGroupConfigRepositories.js";

/**
 * 「规则配置全部入库持久化」的回归保护。
 *
 * 通过 `/rules set` 走完整命令层，写入 fake 仓储后**重新装配一个 store**，
 * 模拟进程重启后从数据库恢复；任何只在内存里生效的字段都会在这里暴露。
 */
describe("rule configuration persistence", () => {
  let configRepo: FakeGroupConfigRepository;
  let settingsRepo: FakeGroupSettingsRepository;
  let configStore: GroupConfigStore;
  let service: AdminCommandService;
  let identityMap: IdentityMapService;

  beforeEach(() => {
    configRepo = new FakeGroupConfigRepository();
    settingsRepo = new FakeGroupSettingsRepository();
    configStore = new GroupConfigStore(
      { groupId: DEFAULT_GROUP_ID },
      configRepo,
      undefined,
      settingsRepo,
    );
    const auditLog = new AuditLogStore();
    const permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
    });
    const joinAudit = new JoinAuditService(auditLog);
    const api = new FakeQQOfficialAPI();
    identityMap = new IdentityMapService();
    identityMap.bindUser("root", "10001");
    identityMap.bindUser("admin", "10002");
    identityMap.bindGroup("g1", "654321");
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval: new JoinApprovalService(api, joinAudit, configStore),
      joinSync: new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 }),
      auditLog,
      identityMap,
    });
  });

  /** 与生产一致：重新装配 store 并从仓储恢复。 */
  async function reload(): Promise<GroupConfigStore> {
    await configStore.flush();
    const reloaded = new GroupConfigStore(
      { groupId: DEFAULT_GROUP_ID },
      configRepo,
      undefined,
      settingsRepo,
    );
    await reloaded.load();
    return reloaded;
  }

  it("persists every /rules set field and restores it after reload", async () => {
    const settings: Array<[string, string]> = [
      ["keywords", "广告,刷屏"],
      ["warning", "请勿违规"],
      ["muteDuration", "120"],
      ["wordFilter", "off"],
      ["joinAudit", "off"],
      ["autoApprove", "on"],
      ["export", "on"],
      ["enabled", "off"],
      ["keywordRecall", "on"],
      ["keywordPunish", "kick_blacklist"],
      ["joinDecision", "reject_on_mismatch"],
      ["joinRequireClass", "on"],
      ["joinRequireName", "on"],
      ["joinAnswerPattern", "^材化\\d{4}$"],
      ["joinReviewOpinion", "off"],
      ["notifyAutoApproved", "on"],
    ];

    for (const [field, value] of settings) {
      const result = await service.handle(
        "g1",
        "admin",
        `/rules set ${field} ${value}`,
      );
      expect(result.ok, `${field} -> ${result.text}`).toBe(true);
    }

    const reloaded = await reload();
    const config = reloaded.get("g1");
    expect(config.keywords).toEqual(["刷屏", "广告"]);
    expect(config.warningMessage).toBe("请勿违规");
    expect(config.muteDurationSeconds).toBe(120);
    expect(config.wordFilterEnabled).toBe(false);
    expect(config.joinAuditEnabled).toBe(false);
    expect(config.autoApproveJoin).toBe(true);
    expect(config.exportEnabled).toBe(true);
    expect(config.enabled).toBe(false);
    expect(config.keywordRecall).toBe(true);
    expect(config.keywordPunish).toBe(KeywordPunish.KickBlacklist);
    expect(config.joinDecision).toBe(JoinDecisionMode.RejectOnMismatch);
    expect(config.joinRequireClass).toBe(true);
    expect(config.joinRequireName).toBe(true);
    expect(config.joinAnswerPattern).toBe("^材化\\d{4}$");
    expect(config.joinReviewOpinion).toBe(false);
    expect(config.notifyAutoApproved).toBe(true);
  });

  it("persists global rules and keeps per-field inheritance after reload", async () => {
    const globals: Array<[string, string]> = [
      ["keywords", "全局词"],
      ["keywordPunish", "mute"],
      ["joinDecision", "approve_on_match"],
      ["joinRequireClass", "on"],
    ];
    for (const [field, value] of globals) {
      const result = await service.handle(
        undefined,
        "root",
        `/rules set all ${field} ${value}`,
      );
      expect(result.ok, `${field} -> ${result.text}`).toBe(true);
    }

    const reloaded = await reload();
    expect(reloaded.default.keywords).toEqual(["全局词"]);
    expect(reloaded.default.keywordPunish).toBe(KeywordPunish.Mute);
    expect(reloaded.default.joinDecision).toBe(JoinDecisionMode.ApproveOnMatch);
    expect(reloaded.default.joinRequireClass).toBe(true);
    // 未单独配置的群继承全局
    expect(reloaded.get("brand-new").keywordPunish).toBe(KeywordPunish.Mute);
    expect(reloaded.get("brand-new").joinRequireClass).toBe(true);
  });

  it("restores a group whose only configuration is extended settings", async () => {
    const result = await service.handle("g1", "admin", "/rules set keywordRecall on");
    expect(result.ok).toBe(true);

    // 只改扩展字段时不会写 group_configs 行
    expect(configRepo.overrides.has("g1")).toBe(false);
    expect(settingsRepo.rows.size).toBeGreaterThan(0);

    const reloaded = await reload();
    expect(reloaded.listOverrides().map((item) => item.groupId)).toEqual(["g1"]);
    expect(reloaded.get("g1").keywordRecall).toBe(true);
    // 其他字段仍继承默认值
    expect(reloaded.get("g1").wordFilterEnabled).toBe(true);
  });

  it("clears both tables when a group override is removed", async () => {
    await service.handle("g1", "admin", "/rules set keywords 广告");
    await service.handle("g1", "admin", "/rules set keywordRecall on");
    await configStore.flush();

    configStore.removeOverride("g1");
    const reloaded = await reload();

    expect(reloaded.listOverrides()).toEqual([]);
    expect(reloaded.get("g1").keywordRecall).toBe(false);
    expect(reloaded.get("g1").keywords).toEqual([]);
    expect(configRepo.overrides.has("g1")).toBe(false);
    expect(settingsRepo.rows.size).toBe(0);
  });

  it("rejects unknown fields instead of silently dropping them", async () => {
    const result = await service.handle(
      "g1",
      "admin",
      "/rules set totally-unknown-value 1",
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未知字段");
    expect(settingsRepo.rows.size).toBe(0);
    expect(configRepo.overrides.size).toBe(0);
  });
});
