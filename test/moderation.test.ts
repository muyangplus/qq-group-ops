import { describe, expect, it } from "vitest";

import { ModerationAction, RiskLevel } from "../src/core/enums.js";
import { RuleEngine } from "../src/services/moderation.js";

describe("RuleEngine", () => {
  it("matches keywords", () => {
    const engine = RuleEngine.fromKeywords(["广告"]);
    const matches = engine.evaluate("这里有广告内容");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.pattern).toBe("广告");
    expect(matches[0]?.action).toBe(ModerationAction.Warn);
  });

  it("matches keywords case-insensitively by default", () => {
    const engine = RuleEngine.fromKeywords(["Spam"]);
    expect(engine.evaluate("this is SPAM content")).toHaveLength(1);
  });

  it("compiles regex with the same flags as validation (iu)", () => {
    // 曾经校验带 u、编译丢 u：\p{sc=Han} 能通过校验但匹配时被当普通字符，规则永远不生效
    const engine = RuleEngine.fromRegex(["\\p{sc=Han}+"]);
    expect(engine.evaluate("中文广告")).toHaveLength(1);
    // 默认不区分大小写
    const urls = RuleEngine.fromRegex(["(?:pan\\.baidu\\.com|lanzou[a-z]?\\.com)"]);
    expect(urls.evaluate("https://PAN.BAIDU.COM/s/1")).toHaveLength(1);
  });

  it("matches regex rules", () => {
    const engine = new RuleEngine([
      {
        ruleId: "url",
        pattern: "https?://",
        action: ModerationAction.Review,
        risk: RiskLevel.High,
        isRegex: true,
      },
    ]);
    const matches = engine.evaluate("访问 https://example.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.action).toBe(ModerationAction.Review);
    expect(matches[0]?.risk).toBe(RiskLevel.High);
  });

  it("returns highest-priority action", () => {
    const engine = new RuleEngine([
      { ruleId: "warn", pattern: "warn", action: ModerationAction.Warn },
      { ruleId: "kick", pattern: "kick", action: ModerationAction.Kick },
    ]);
    expect(engine.highestAction("warn kick")).toBe(ModerationAction.Kick);
  });

  it("returns allow when nothing matches", () => {
    const engine = RuleEngine.fromKeywords(["广告"]);
    expect(engine.highestAction("正常聊天")).toBe(ModerationAction.Allow);
  });

  it("ignores disabled rules", () => {
    const engine = new RuleEngine([
      { ruleId: "disabled", pattern: "广告", enabled: false },
    ]);
    expect(engine.evaluate("广告")).toEqual([]);
  });

  it("throws on invalid regex", () => {
    expect(
      () => new RuleEngine([{ ruleId: "bad", pattern: "[", isRegex: true }]),
    ).toThrowError(/invalid regex/u);
  });
});
