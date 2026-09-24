import { describe, expect, it } from "vitest";

import { ClassAliasService } from "../src/services/classAliases.js";
import { JoinRuleEvaluator } from "../src/services/joinRules.js";
import { MemberRoster } from "../src/services/memberRoster.js";

const roster = MemberRoster.fromIndex({
  classes: ["材化2211", "计科2201"],
  majors: ["材料化学", "计算机科学与技术"],
  classInfo: {
    材化2211: {
      major: "材料化学",
      college: "化学与生命科学学院",
      year: "2022",
    },
  },
});

const evaluator = new JoinRuleEvaluator(roster);
const classAndName = {
  requireClass: true,
  requireName: true,
  opinionEnabled: true,
} as const;

describe("JoinRuleEvaluator", () => {
  it("matches 班级+姓名 and explains the hit", () => {
    const result = evaluator.evaluate("材化2211 张三", {
      ...classAndName,
      mode: "manual",
    });

    expect(result.matched).toBe(true);
    expect(result.className).toBe("材化2211");
    expect(result.major).toBe("材料化学");
    expect(result.name).toBe("张三");
    expect(result.action).toBe("manual");
    expect(result.opinion).toContain("审核意见");
    expect(result.opinion).toContain("班级 材化2211（材料化学 / 化学与生命科学学院 / 2022 级）");
    expect(result.opinion).toContain("姓名 张三");
    expect(result.opinion).toContain("建议：人工核实");
  });

  it("lists what is missing", () => {
    const result = evaluator.evaluate("我想加入", {
      ...classAndName,
      mode: "manual",
    });

    expect(result.matched).toBe(false);
    expect(result.missing).toEqual(["班级", "姓名"]);
    expect(result.opinion).toContain("缺少：班级、姓名");
  });

  it("supports every decision mode", () => {
    const modes = [
      ["auto_approve", "材化2211 张三", "approve"],
      ["auto_approve", "随便", "approve"],
      ["approve_on_match", "材化2211 张三", "approve"],
      ["approve_on_match", "随便", "manual"],
      ["reject_on_match", "材化2211 张三", "reject"],
      ["reject_on_match", "随便", "manual"],
      ["reject_on_mismatch", "材化2211 张三", "manual"],
      ["reject_on_mismatch", "随便", "reject"],
      ["manual", "材化2211 张三", "manual"],
    ] as const;

    for (const [mode, answer, expected] of modes) {
      const result = evaluator.evaluate(answer, { ...classAndName, mode });
      expect(result.action, `${mode} / ${answer}`).toBe(expected);
    }
  });

  it("requires the class roster for class rules", () => {
    const withoutRoster = new JoinRuleEvaluator(undefined);
    const result = withoutRoster.evaluate("材化2211 张三", {
      ...classAndName,
      mode: "approve_on_match",
    });

    expect(result.matched).toBe(false);
    expect(result.configIssue).toContain("班级库未加载");
    expect(result.action).toBe("manual");
    expect(withoutRoster.rosterAvailable).toBe(false);
  });

  it("falls back to manual review when no requirement is configured", () => {
    const result = evaluator.evaluate("随便", {
      mode: "approve_on_match",
      requireClass: false,
      requireName: false,
      opinionEnabled: true,
    });

    expect(result.matched).toBe(false);
    expect(result.configIssue).toContain("未配置入群审核规则");
    expect(result.action).toBe("manual");
    expect(result.opinion).toContain("建议：人工核实");
  });

  it("supports a custom answer pattern", () => {
    const ok = evaluator.evaluate("材化2211 张三", {
      mode: "approve_on_match",
      requireClass: true,
      requireName: true,
      answerPattern: "^材化\\d{4}\\s+\\S{2,4}$",
      opinionEnabled: true,
    });
    expect(ok.matched).toBe(true);
    expect(ok.action).toBe("approve");

    const bad = evaluator.evaluate("材化2211 张三 谢谢", {
      mode: "approve_on_match",
      requireClass: true,
      requireName: true,
      answerPattern: "^材化\\d{4}\\s+\\S{2,4}$",
      opinionEnabled: true,
    });
    expect(bad.matched).toBe(false);
    expect(bad.missing.join()).toContain("自定义规则");
    expect(bad.action).toBe("manual");
  });

  it("reports an invalid pattern and never auto decides", () => {
    const result = evaluator.evaluate("材化2211 张三", {
      mode: "reject_on_match",
      requireClass: true,
      requireName: true,
      answerPattern: "([unclosed",
      opinionEnabled: true,
    });

    expect(result.configIssue).toContain("不是合法正则");
    expect(result.action).toBe("manual");
  });

  it("omits the opinion when disabled", () => {
    const result = evaluator.evaluate("材化2211 张三", {
      ...classAndName,
      mode: "manual",
      opinionEnabled: false,
    });
    expect(result.opinion).toBe("");
  });

  it("accepts a class alias for the class match", () => {
    const aliases = new ClassAliasService();
    aliases.setRoster(roster);
    aliases.set("材化1班", "材化2211");
    const withAliases = new JoinRuleEvaluator(roster);
    withAliases.setAliases(aliases);

    const hit = withAliases.evaluate("材化1班 张三", {
      mode: "approve_on_match",
      requireClass: true,
      requireName: true,
      opinionEnabled: true,
    });
    expect(hit.matched).toBe(true);
    expect(hit.className).toBe("材化2211");
    expect(hit.name).toBe("张三");
    expect(hit.action).toBe("approve");

    // 不含别名的回答行为不变
    const miss = withAliases.evaluate("材化1班", {
      mode: "approve_on_match",
      requireClass: true,
      requireName: true,
      opinionEnabled: true,
    });
    expect(miss.name).toBeUndefined();
    expect(miss.action).toBe("manual");
  });
});
