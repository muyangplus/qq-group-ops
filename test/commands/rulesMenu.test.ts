import { FakeQQOfficialAPI } from "../../src/adapters/fakeQqOfficial.js";
import { AdminCommandService } from "../../src/services/adminCommands.js";
import { AuditLogStore } from "../../src/services/audit.js";
import { GroupConfigStore } from "../../src/services/groupConfig.js";
import { IdentityMapService } from "../../src/services/identityMap.js";
import { JoinApprovalService } from "../../src/services/joinApproval.js";
import { JoinAuditService } from "../../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../../src/services/joinAuditSync.js";
import { MemberRoster } from "../../src/services/memberRoster.js";
import { PermissionService } from "../../src/services/permissions.js";
import {
  describe,
  expect,
  it,
  beforeEach,
} from "vitest";

/**
 * 规则菜单重构（§C）：子卡与卡片标准
 */

describe("rule menu refactor (§C)", async () => {
  let auditLog: AuditLogStore;
  let joinAudit: JoinAuditService;
  let configStore: GroupConfigStore;
  let identityMap: IdentityMapService;
  let permissions: PermissionService;
  let api: FakeQQOfficialAPI;
  let service: AdminCommandService;
  let roster: MemberRoster;

  function buttonsOf(card: { rich?: { keyboard?: { content: { rows: Array<{ buttons: Array<{ id: string; label: string; action: { type: number; data: string } }> }> } } } }): Array<{ id: string; label: string; action: { type: number; data: string } }> {
    return (card.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
  }

  /** 所有示例卡片都必须满足卡片标准（≤5 行、每行 ≤12 字、单按钮 ≤10 字）。 */
  function expectWithinCardLimits(
    card: { rich?: { keyboard?: { content: { rows: Array<{ buttons: Array<{ label: string }> }> } } } },
    label: string,
  ): void {
    const rows = card.rich?.keyboard?.content.rows ?? [];
    expect(rows.length, label).toBeLessThanOrEqual(5);
    for (const row of rows) {
      const width = row.buttons.reduce((sum, button) => sum + button.label.length, 0);
      expect(width, `${label} row`).toBeLessThanOrEqual(12);
      for (const button of row.buttons) {
        expect(button.label.length, `${label} ${button.label}`).toBeLessThanOrEqual(10);
      }
    }
  }

  beforeEach(() => {
    auditLog = new AuditLogStore();
    permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      moderatorIds: new Map([["g1", new Set(["mod"])]]),
    });
    joinAudit = new JoinAuditService(auditLog);
    configStore = new GroupConfigStore({
      groupId: "__default__",
      keywords: ["广告"],
    });
    api = new FakeQQOfficialAPI();
    identityMap = new IdentityMapService();
    identityMap.bindUser("member", "10001");
    identityMap.bindUser("mod", "10002");
    identityMap.bindUser("admin", "10003");
    identityMap.bindUser("root", "10004");
    identityMap.bindGroup("g1", "654321");
    roster = MemberRoster.fromIndex({
      classes: ["材化2211", "环工2414"],
      majors: ["材料化学", "环境工程"],
      classInfo: {
        材化2211: {
          major: "材料化学",
          college: "化学与生命科学学院",
          year: "2022",
        },
        环工2414: {
          major: "环境工程",
          college: "环境科学与工程学院",
          year: "2024",
        },
      },
    });
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval: new JoinApprovalService(api, joinAudit, configStore),
      joinSync: new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 }),
      auditLog,
      identityMap,
      activityRoster: roster,
    });
  });

  it("shows current state on switch labels and toggles back to the same panel", async () => {
    const panel = service.rulesPanelCard("toggle", "g1", "admin");
    const buttons = buttonsOf(panel);
    // 当前 = 开 → 标签显示「开」，点击后回包切换
    expect(buttons.find((button) => button.id === "wordFilterEnabled")?.label).toBe(
      "过滤 开",
    );
    expect(
      buttons.find((button) => button.id === "wordFilterEnabled")?.action,
    ).toMatchObject({
      type: 1,
      data: "cb:rules:toggle:g1:wordFilterEnabled:off:toggle",
    });
    expect(panel.rich.markdown).toContain("过滤：开（继承全局）");
    // 点击 → 更新为关，并回到同一张子卡
    const toggled = await service.toggleRulesCard(
      "g1",
      "wordFilterEnabled",
      "off",
      "admin",
      "toggle",
      "g1",
    );
    expect(toggled.ok).toBe(true);
    expect(configStore.get("g1").wordFilterEnabled).toBe(false);
    expect(toggled.rich.markdown).toContain("已更新：关键词过滤 = off");
    expect(buttonsOf(toggled).find((button) => button.id === "wordFilterEnabled")?.label).toBe(
      "过滤 关",
    );
  });

  it("shows the override state in the overview and resets one page", async () => {
    configStore.setOverride({ groupId: "g1", wordFilterEnabled: false, keywords: ["刷屏"] });

    const overview = service.rulesCard("g1", "admin", ["rules"]);
    expect(overview.rich.markdown).toContain("**本群覆盖**：关键词、关键词过滤");

    const panel = service.rulesPanelCard("toggle", "g1", "admin");
    expect(panel.rich.markdown).toContain("过滤：关（本群覆盖）");
    const restore = buttonsOf(panel).find((button) => button.id === "reset-toggle");
    expect(restore?.action).toMatchObject({
      type: 1,
      data: "cb:rules:resetPage:g1:toggle:wordFilterEnabled,keywordRecall,joinAuditEnabled,exportEnabled:1:allow",
    });
    expect(restore?.action.type).toBe(1);

    const reset = service.resetRulePageCard(
      "g1",
      "toggle",
      "wordFilterEnabled,keywordRecall,joinAuditEnabled,exportEnabled",
      "admin",
    );
    expect(reset.ok).toBe(true);
    expect(configStore.get("g1").wordFilterEnabled).toBe(true);
    // 关键词的覆盖不受影响
    expect(configStore.get("g1").keywords).toEqual(["刷屏"]);
    expect(reset.rich.markdown).toContain("已恢复本页继承");
  });

  it("resets every override from the overview", async () => {
    configStore.setOverride({ groupId: "g1", wordFilterEnabled: false, keywords: ["刷屏"] });

    const result = service.resetAllRulesCard("g1", "admin", "g1");
    expect(result.ok).toBe(true);
    expect(configStore.get("g1").wordFilterEnabled).toBe(true);
    expect(configStore.get("g1").keywords).toEqual(["广告"]);
    expect(configStore.overriddenFields("g1").size).toBe(0);
    expect(result.rich.markdown).toContain("已恢复全部继承");
  });

  it("adds and deletes keywords one by one with pagination", async () => {
    await service.handle("g1", "admin", "/rules add keyword 刷屏");
    await service.handle("g1", "admin", "/rules add keyword 代刷");
    await service.handle("g1", "admin", "/rules add keyword 外挂");

    // 默认有 1 个继承关键词；新增 3 个 → 共 4 条，每页 3 条 → 2 页
    const first = service.rulesPanelCard("keyword", "g1", "admin");
    const firstButtons = buttonsOf(first);
    expect(first.rich.markdown).toContain("4 条 · 第 1 / 2 页");
    expect(firstButtons.filter((button) => button.id.startsWith("del-"))).toHaveLength(3);
    expect(firstButtons.find((button) => button.id === "next")?.action).toMatchObject({
      type: 1,
      data: "cb:rules:panelPage:g1:keyword:2",
    });

    const second = service.rulesPanelCard("keyword", "g1", "admin", undefined, 2);
    expect(second.rich.markdown).toContain("第 2 / 2 页");
    expect(buttonsOf(second).some((button) => button.id === "prev")).toBe(true);

    // 删掉第 1 页第一条 → 回本页
    const deleted = service.delKeywordCard("g1", 0, 1, "admin", "g1");
    expect(deleted.ok).toBe(true);
    expect(deleted.rich.markdown).toContain("已删除关键词");
    expect(configStore.get("g1").keywords).toHaveLength(3);

    // 越权删除被拒
    const denied = service.delKeywordCard("g1", 0, 1, "mod", "g1");
    expect(denied.ok).toBe(false);
    expect(denied.rich.markdown).toContain("权限不足");

    // 清空关键词
    const cleared = service.clearKeywordsCard("g1", "admin", "g1");
    expect(cleared.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual([]);
    expect(cleared.rich.markdown).toContain("已清空关键词");
  });

  it("rejects duplicate or oversized keywords and missing deletes", async () => {
    const duplicate = await service.handle("g1", "admin", "/rules add keyword 广告");
    expect(duplicate.ok).toBe(false);
    expect(duplicate.text).toContain("已存在");

    const missing = await service.handle("g1", "admin", "/rules del keyword 不存在");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("不存在");

    const oversized = await service.handle(
      "g1",
      "admin",
      `/rules add keyword ${"长".repeat(60)}`,
    );
    expect(oversized.ok).toBe(false);
    expect(oversized.text).toContain("50");

    // 权限同 /rules set
    const denied = await service.handle("g1", "mod", "/rules add keyword 新词");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
  });

  it("picks colleges and years from the roster with allow/deny modes", async () => {
    const panel = service.rulesPanelCard("roster", "g1", "admin");
    const buttons = buttonsOf(panel);
    const college = buttons.find(
      (button) => button.id === "college-化学与生命科学学院",
    );
    expect(college?.label).toBe("化学与生命科学学院");
    expect(college?.action).toMatchObject({
      type: 1,
      data: "cb:rules:toggle:g1:allowColleges:化学与生命科学学院:roster",
    });

    // 白/黑名单模式切换走 panelPage（不能走字段设置回调）
    const denyMode = buttons.find((button) => button.id === "roster-deny");
    expect(denyMode?.action).toMatchObject({
      type: 1,
      data: "cb:rules:panelPage:g1:roster:1:deny",
    });
    const denyPanel = service.rulesPanelCard("roster", "g1", "admin", undefined, 1, "deny");
    expect(denyPanel.rich.markdown).toContain("黑名单（禁止）");

    // 点选学院 → 进入白名单覆盖
    const toggled = service.rosterToggleCard(
      "g1",
      "allowColleges",
      "allow",
      "化学与生命科学学院",
      "admin",
      "g1",
    );
    expect(toggled.ok).toBe(true);
    expect(configStore.get("g1").allowColleges).toEqual(["化学与生命科学学院"]);

    // 点选年级
    const year = service.rosterToggleCard("g1", "allowYears", "allow", "22", "admin", "g1");
    expect(year.ok).toBe(true);
    expect(configStore.get("g1").allowYears).toEqual(["22"]);

    // 黑名单模式：切换后再点一次取消选中
    const denied = service.rosterToggleCard(
      "g1",
      "allowColleges",
      "allow",
      "化学与生命科学学院",
      "admin",
      "g1",
    );
    expect(denied.ok).toBe(true);
    expect(configStore.get("g1").allowColleges).toEqual([]);

    // 普通成员被拒
    const rejected = service.rosterToggleCard("g1", "allowYears", "allow", "23", "member");
    expect(rejected.ok).toBe(false);
    expect(rejected.rich.markdown).toContain("权限不足");
  });

  it("renders the global rules card with the same subcards and a coverage overview", async () => {
    configStore.setOverride({ groupId: "g1", wordFilterEnabled: false });
    configStore.setOverride({ groupId: "g2", keywords: ["刷屏"] });

    const global = await service.handle("g1", "root", "/rules all");
    expect(global.ok).toBe(true);
    const buttons = buttonsOf(global);
    expect(
      buttons.find((button) => button.id === "panel-toggle")?.action,
    ).toMatchObject({
      type: 1,
      data: "cb:rules:panel:__default__:toggle",
    });
    expect(global.rich.markdown).toContain("只影响未单独覆盖该字段的群");

    // 全局子卡与群子卡同构：目标群是 __default__
    const globalPanel = service.rulesPanelCard("toggle", "__default__", "root");
    expect(globalPanel.ok).toBe(true);
    expect(globalPanel.rich.markdown).toContain("全局");

    // 覆盖率总览
    const overview = service.ruleOverridesCard("root");
    expect(overview.ok).toBe(true);
    expect(overview.rich.markdown).toContain("共 2 个群有覆盖");
    expect(overview.rich.markdown).toContain("过滤");
    expect(overview.rich.markdown).toContain("关键词");

    // 非超管被拒
    const denied = service.ruleOverridesCard("admin");
    expect(denied.ok).toBe(false);
    expect(denied.rich.markdown).toContain("仅超级管理员");
  });

  it("keeps every rules card inside the card layout limits", async () => {
    configStore.setOverride({ groupId: "g1", keywords: ["广告", "刷屏", "代刷", "外挂"] });
    const cards: Array<[string, unknown]> = [
      ["overview", service.rulesCard("g1", "admin", ["rules"])],
      ["toggle", service.rulesPanelCard("toggle", "g1", "admin")],
      ["decision", service.rulesPanelCard("decision", "g1", "admin")],
      ["punish", service.rulesPanelCard("punish", "g1", "admin")],
      ["keyword", service.rulesPanelCard("keyword", "g1", "admin")],
      ["roster", service.rulesPanelCard("roster", "g1", "admin")],
      ["more", service.rulesPanelCard("more", "g1", "admin")],
      ["global", service.rulesCard("g1", "root", ["rules", "all"])],
      ["overrides", service.ruleOverridesCard("root")],
    ];
    for (const [label, card] of cards) {
      expectWithinCardLimits(card as never, label);
    }
  });

  it("keeps /rules set as the fallback path, including all", async () => {
    const set = await service.handle("g1", "admin", "/rules set keywords 广告,刷屏");
    expect(set.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual(["刷屏", "广告"]);

    const all = await service.handle("g1", "root", "/rules set all warning 全局文案");
    expect(all.ok).toBe(true);
    expect(configStore.default.warningMessage).toBe("全局文案");
  });
});
