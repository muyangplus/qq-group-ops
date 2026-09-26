import {
  describe,
  expect,
  it,
} from "vitest";
import {
  configStore,
  service,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · rules（12 个用例）。
 */

describe("AdminCommandService · rules", () => {
  it("shows rules", async () => {
    const result = await service.handle("g1", "mod", "/rules");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("广告");
  });

  it("configures the multi-select punish actions", async () => {
    // §B2 多选：可以一次设置多个动作
    await service.handle("g1", "admin", "/rules set punish 警告,撤回,禁言");

    expect(configStore.get("g1").punishActions).toEqual({
      warn: true,
      recall: true,
      mute: true,
      kick: false,
      blacklist: false,
    });

    // 英文别名 + 覆盖式写入（整组替换）
    await service.handle("g1", "admin", "/rules set 处罚 kick blacklist");
    expect(configStore.get("g1").punishActions).toEqual({
      warn: false,
      recall: false,
      mute: false,
      kick: true,
      blacklist: true,
    });

    // 清空 = 五个动作全关
    await service.handle("g1", "admin", "/rules set punish none");
    expect(configStore.get("g1").punishActions).toEqual({
      warn: false,
      recall: false,
      mute: false,
      kick: false,
      blacklist: false,
    });

    const invalid = await service.handle("g1", "admin", "/rules set punish 不存在的动作");
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain("未知的违规处理动作");
  });

  it("reports content-audit regex errors with the right label and a Chinese hint", async () => {
    // 真机踩过：内容审核正则报错写成「入群正则不合法」，让人以为配错了字段
    const bad = await service.handle("g1", "admin", "/rules add regex (?i)foo");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("内容审核正则不合法");
    expect(bad.text).toContain("不支持内联标志");
    expect(bad.text).not.toContain("入群正则");

    const join = await service.handle(
      "g1",
      "admin",
      "/rules set joinAnswerPattern (?i)材化\\d+",
    );
    expect(join.ok).toBe(false);
    expect(join.text).toContain("入群答案正则不合法");
    expect(join.text).toContain("不支持内联标志");
  });

  it("updates group keywords with /rules set", async () => {
    const result = await service.handle("g1", "admin", "/rules set keywords 广告,刷屏");

    expect(result.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual(["刷屏", "广告"]);
    expect(result.text).toContain("刷屏");
  });

  it("clears keywords with /rules set keywords clear", async () => {
    await service.handle("g1", "admin", "/rules set keywords 广告");
    const result = await service.handle("g1", "admin", "/rules set keywords clear");

    expect(result.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual([]);
  });

  it("toggles switches and numbers with /rules set", async () => {
    await service.handle("g1", "admin", "/rules set autoApprove on");
    await service.handle("g1", "admin", "/rules set wordFilter off");
    await service.handle("g1", "admin", "/rules set muteDuration 120");
    await service.handle("g1", "admin", "/rules set warning 请勿刷屏");

    const config = configStore.get("g1");
    expect(config.autoApproveJoin).toBe(true);
    expect(config.wordFilterEnabled).toBe(false);
    expect(config.muteDurationSeconds).toBe(120);
    expect(config.warningMessage).toBe("请勿刷屏");
  });

  it("supports the documented private rule flow with a bound group number", async () => {
    const keywords = await service.handle(
      undefined,
      "root",
      "/rules set 654321 keywords 广告,刷屏",
    );
    expect(keywords.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual(["刷屏", "广告"]);

    const warning = await service.handle(
      undefined,
      "root",
      "/rules set 654321 warning 本群禁止广告与刷屏，请撤回并阅读群规。",
    );
    expect(warning.ok).toBe(true);
    expect(configStore.get("g1").warningMessage).toBe(
      "本群禁止广告与刷屏，请撤回并阅读群规。",
    );

    const view = await service.handle(undefined, "root", "/rules 654321");
    expect(view.ok).toBe(true);
    expect(view.text).toContain("本群禁止广告与刷屏");
    expect(view.text).toContain("刷屏");
    expect(view.text).toContain("禁言时长");

    const unknown = await service.handle(
      undefined,
      "root",
      "/rules set 654321 unknown 1",
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("未知字段");

    const badToggle = await service.handle(
      undefined,
      "root",
      "/rules set 654321 autoApprove maybe",
    );
    expect(badToggle.ok).toBe(false);
    expect(badToggle.text).toContain("需要 on 或 off");

    const badDuration = await service.handle(
      undefined,
      "root",
      "/rules set 654321 muteDuration abc",
    );
    expect(badDuration.ok).toBe(false);
    expect(badDuration.text).toContain("禁言时长需要非负整数（秒）");
  });

  it("accepts the 全局 alias for global rules", async () => {
    const set = await service.handle("g1", "root", "/rules set 全局 autoApprove on");
    expect(set.ok).toBe(true);
    expect(configStore.default.autoApproveJoin).toBe(true);

    const view = await service.handle(undefined, "root", "/rules 全局");
    expect(view.ok).toBe(true);
    expect(view.text).toContain("全局默认规则");
  });

  it("requires a field and value for global rules", async () => {
    const result = await service.handle("g1", "root", "/rules set all");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("/rules set all <字段> <值>");
  });

  it("clears global keywords with /rules set all keywords clear", async () => {
    await service.handle("g1", "root", "/rules set all keywords 全局词");
    expect(configStore.default.keywords).toEqual(["全局词"]);
    expect(configStore.get("g-other").keywords).toEqual(["全局词"]);

    const cleared = await service.handle(
      "g1",
      "root",
      "/rules set all keywords clear",
    );

    expect(cleared.ok).toBe(true);
    expect(configStore.default.keywords).toEqual([]);
    expect(configStore.get("g-other").keywords).toEqual([]);
  });

  it("supports /rules set from private with a group id", async () => {
    const result = await service.handle(
      undefined,
      "root",
      "/rules set g1 autoApprove on",
    );

    expect(result.ok).toBe(true);
    expect(configStore.get("g1").autoApproveJoin).toBe(true);
  });

  it("renders /rules as an overview card plus setting panels", async () => {
    const overview = await service.handle("g1", "admin", "/rules");

    expect(overview.ok).toBe(true);
    const overviewButtons = (overview.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    // 概览卡只给设置入口：开关 / 决策 / 处罚
    expect(
      overviewButtons.find((button) => button.id === "panel-toggle")?.action,
    ).toMatchObject({ type: 1, data: "cb:rules:panel:g1:toggle" });
    expect(
      overviewButtons.find((button) => button.id === "panel-decision")?.action,
    ).toMatchObject({ type: 1, data: "cb:rules:panel:g1:decision" });
    // 按钮已经表达的开关/枚举状态不再用大段文字重复
    expect(overview.rich?.markdown).not.toContain("入群决策：");
    expect(overview.rich?.markdown).not.toContain("命中处罚：");
    // 按钮没覆盖的字段仍然展示
    expect(overview.rich?.markdown).toContain("**关键词**");
    expect(overview.rich?.markdown).toContain("**禁言时长**");

    // 开关子卡：一行 2 个，点击即切换
    const switches = service.rulesPanelCard("toggle", "g1", "admin");
    const switchButtons = (switches.rich.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(
      switchButtons.find((button) => button.id === "wordFilterEnabled")?.action,
    ).toMatchObject({ type: 1, data: "cb:rules:toggle:g1:wordFilterEnabled:off:toggle" });
    expect((switches.rich.keyboard?.content.rows ?? [])[0]?.buttons).toHaveLength(2);

    // 决策子卡：枚举当前值带 ● 标记
    const decision = service.rulesPanelCard("decision", "g1", "admin");
    const decisionButtons = (decision.rich.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(
      decisionButtons.find((button) => button.id === "decision-match")?.action,
    ).toMatchObject({
      type: 1,
      data: "cb:rules:toggle:g1:joinDecision:approve_on_match:decision",
    });
    expect(
      decisionButtons.find((button) => button.id === "decision-manual")?.label,
    ).toBe("● 人工");
  });

  it("toggles rules via callback with operator feedback", async () => {
    const result = await service.toggleRulesCard(
      "g1",
      "wordFilterEnabled",
      "off",
      "admin",
      undefined,
      "g1",
    );

    expect(result.ok).toBe(true);
    // 中文名 + 中文值：面板按钮上怎么写，提示就怎么写（不再回 `wordFilterEnabled = off`）
    expect(result.rich.markdown).toContain("已更新：关键词过滤 → 关");
    expect(result.rich.markdown.split("\n")[1]).toBe("<@!admin>");
    expect(result.rich.markdown).not.toContain("操作人：");
    expect(configStore.get("g1").wordFilterEnabled).toBe(false);
  });

  it("configures raw message retention days", async () => {
    const set = await service.handle("g1", "admin", "/rules set rawMessageRetentionDays 7");
    expect(set.ok).toBe(true);
    expect(configStore.get("g1").rawMessageRetentionDays).toBe(7);

    // 0 = 不保留；clear 等同归零
    await service.handle("g1", "admin", "/rules set rawMessageRetentionDays 0");
    expect(configStore.get("g1").rawMessageRetentionDays).toBe(0);

    await service.handle("g1", "admin", "/rules set rawMessageRetentionDays 7");
    await service.handle("g1", "admin", "/rules set rawMessageRetentionDays clear");
    expect(configStore.get("g1").rawMessageRetentionDays).toBe(0);

    // 非法值：负数 / 非数字都拒绝，且不改配置
    await service.handle("g1", "admin", "/rules set rawMessageRetentionDays 7");
    for (const bad of ["-1", "abc", "1.5"]) {
      const invalid = await service.handle("g1", "admin", `/rules set rawMessageRetentionDays ${bad}`);
      expect(invalid.ok, bad).toBe(false);
      expect(invalid.text, bad).toContain("需要 0 或正整数");
      expect(configStore.get("g1").rawMessageRetentionDays, bad).toBe(7);
    }
    // 用法里也列出了这个字段
    const usage = await service.handle("g1", "admin", "/rules set");
    expect(usage.text).toContain("rawMessageRetentionDays");
  });

  it("lists the retention entry on the 更多设置 panel", () => {
    const panel = service.rulesPanelCard("more", "g1", "admin");
    const labels = (panel.rich.keyboard?.content.rows ?? [])
      .flatMap((row) => row.buttons)
      .map((button) => button.label);
    expect(labels).toContain("消息保留");
    expect(panel.rich.markdown).toContain("消息保留");
  });

  it("pages the keyword panel with a copyable /rules keyword command", async () => {
    await service.handle("g1", "admin", "/rules set keywords 广告,刷屏,加群,代写");

    const first = await service.handle("g1", "admin", "/rules keyword");
    expect(first.ok).toBe(true);
    expect(first.text).toContain("下一页：/rules keyword +2");

    const second = await service.handle("g1", "admin", "/rules keyword +2");
    expect(second.ok).toBe(true);
    expect(second.text).toContain("上一页：/rules keyword +1");
    expect(second.text).not.toContain("下一页：/rules keyword +3");
    expect(second.text).not.toBe(first.text);

    // 私信里带群参数也能翻页
    const scoped = await service.handle(undefined, "admin", "/rules keyword g1 +2");
    expect(scoped.ok).toBe(true);
    expect(scoped.text).toContain("上一页：/rules keyword +1");
  });
});
