import { describe, expect, it } from "vitest";

import { KeywordPunish, ModerationAction } from "../src/core/enums.js";
import { newIncomingMessage } from "../src/core/models.js";
import { AuditLogStore } from "../src/services/audit.js";
import { parseRegexRules } from "../src/services/commands/support.js";
import { MessageGuardService } from "../src/services/messageGuard.js";
import { RuleEngine } from "../src/services/moderation.js";
import {
  api,
  configStore,
  permissions,
  service,
} from "./helpers/adminCommandsHarness.js";

/**
 * §B1：消息侧「正则 + 白名单」。
 *
 * - 正则与关键词走**同一条处罚管道**（命中动作 = 本群 keywordPunish）；
 * - 白名单用户与审核员一样豁免判断；
 * - 配置字段进 `group_settings` 键值表，旧库不需要迁移。
 */
describe("§B1 正则规则引擎", () => {
  it("compiles regex rules and skips invalid ones", () => {
    const engine = RuleEngine.fromRegex(["\\d{3,}", "(["]);

    const matches = engine.evaluate("订单 12345");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.ruleId).toBe("regex:\\d{3,}");
    expect(matches[0]?.reason).toContain("命中正则");
    expect(engine.highestAction("没有数字")).toBe(ModerationAction.Allow);
  });

  it("parses 顿号-separated regex lists and rejects invalid patterns", () => {
    expect(parseRegexRules("\\d{3,}、^广告")).toEqual(["\\d{3,}", "^广告"]);
    expect(() => parseRegexRules("([")).toThrow(/正则|Invalid|invalid/u);
    expect(() => parseRegexRules("   ")).toThrow(/不能为空/u);
  });
});

describe("§B1 MessageGuard 正则与白名单", () => {
  it("applies the configured punish on a regex hit and writes audit", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: [],
      regexRules: ["\\d{8,}"],
      punishActions: { warn: true, recall: false, mute: true, kick: false, blacklist: false },
      muteDurationSeconds: 60,
      wordFilterEnabled: true,
    });
    const auditLog = new AuditLogStore();
    const guard = new MessageGuardService(
      api,
      new RuleEngine(),
      configStore,
      auditLog,
      permissions,
    );

    const result = await guard.handleMessage(
      newIncomingMessage("g1", "member", "m1", "我的号 12345678"),
    );

    expect(result.action).toBe(ModerationAction.Warn);
    expect(result.executed).toBe(true);
    expect(api.mutedMembers).toContainEqual(["g1", "member", 60]);
    expect(auditLog.all().at(-1)?.action).toBe("moderation:warn");
    expect(auditLog.all().at(-1)?.reason).toContain("命中正则");
  });

  it("exempts whitelisted users from keyword and regex checks", async () => {
    configStore.setOverride({
      groupId: "g1",
      keywords: ["广告"],
      regexRules: ["\\d{8,}"],
      userWhitelist: ["member"],
      punishActions: { warn: true, recall: false, mute: true, kick: false, blacklist: false },
      muteDurationSeconds: 60,
    });
    const guard = new MessageGuardService(api, new RuleEngine(), configStore);

    const regexHit = await guard.handleMessage(
      newIncomingMessage("g1", "member", "m1", "12345678"),
    );
    const keywordHit = await guard.handleMessage(
      newIncomingMessage("g1", "member", "m2", "广告"),
    );

    expect(regexHit.detail).toBe("whitelisted");
    expect(keywordHit.detail).toBe("whitelisted");
    expect(api.mutedMembers).toHaveLength(0);
  });

  it("picks up regex rule changes without restarting", async () => {
    const guard = new MessageGuardService(api, new RuleEngine(), configStore);
    configStore.setOverride({ groupId: "g1", keywords: [], regexRules: ["abc"] });
    expect(
      (await guard.handleMessage(newIncomingMessage("g1", "member", "m1", "abc")))
        .executed,
    ).toBe(true);

    configStore.setOverride({ groupId: "g1", regexRules: ["xyz"] });
    expect(
      (await guard.handleMessage(newIncomingMessage("g1", "member", "m2", "abc")))
        .action,
    ).toBe(ModerationAction.Allow);
  });
});

describe("§B1 /rules 正则与白名单入口", () => {
  it("adds and deletes regex entries with validation", async () => {
    const added = await service.handle("g1", "admin", "/rules add regex \\d{6,}");
    expect(added.ok).toBe(true);
    expect(configStore.get("g1").regexRules).toEqual(["\\d{6,}"]);

    const duplicate = await service.handle("g1", "admin", "/rules add regex \\d{6,}");
    expect(duplicate.ok).toBe(false);
    expect(duplicate.text).toContain("已存在");

    const invalid = await service.handle("g1", "admin", "/rules add regex ([");
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain("正则不合法");

    const removed = await service.handle("g1", "admin", "/rules del regex 1");
    expect(removed.ok).toBe(true);
    expect(configStore.get("g1").regexRules).toEqual([]);
  });

  it("manages the user whitelist and exposes the regex sub-card", async () => {
    const added = await service.handle("g1", "admin", "/rules add whitelist u3");
    expect(added.ok).toBe(true);
    expect(configStore.get("g1").userWhitelist).toEqual(["u3"]);

    const list = await service.handle("g1", "admin", "/rules set regexRules ^广告、\\d{6,}");
    expect(list.ok).toBe(true);
    // 列表字段统一 trim + 去重 + 字典序保存
    expect(configStore.get("g1").regexRules).toEqual(["\\d{6,}", "^广告"]);

    const panel = service.rulesPanelCard("regex", "g1", "admin");
    expect(panel.ok).toBe(true);
    expect(panel.text).toContain("正则规则");
    expect(panel.text).toContain("用户白名单");
    expect(panel.text).toContain("10005");

    const cleared = service.clearRuleListCard("g1", "userWhitelist", "admin", "g1");
    expect(cleared.text).toContain("已清空");
    expect(configStore.get("g1").userWhitelist).toEqual([]);

    const denied = service.clearRuleListCard("g1", "regexRules", "member", "g1");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
  });
});
