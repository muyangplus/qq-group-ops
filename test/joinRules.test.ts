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

  it("enforces college / year allow and deny lists", () => {
    const base = {
      mode: "approve_on_match",
      requireClass: false,
      requireName: false,
      opinionEnabled: true,
    } as const;

    // 学院白名单：命中通过、不含则人工
    const allowHit = evaluator.evaluate("材化2211 张三", {
      ...base,
      allowColleges: ["化学与生命科学学院"],
    });
    expect(allowHit.matched).toBe(true);
    expect(allowHit.action).toBe("approve");

    const allowMiss = evaluator.evaluate("材化2211 张三", {
      ...base,
      allowColleges: ["计算机学院"],
    });
    expect(allowMiss.matched).toBe(false);
    expect(allowMiss.missing.join()).toContain("学院白名单");
    // 名单是硬约束：白名单外直接拒绝（不是转人工）
    expect(allowMiss.action).toBe("reject");

    // 学院黑名单：命中拒绝、其他学院不受影响
    const denyHit = evaluator.evaluate("材化2211 张三", {
      ...base,
      denyColleges: ["化学与生命科学学院"],
    });
    expect(denyHit.matched).toBe(false);
    expect(denyHit.missing.join()).toContain("学院黑名单");
    expect(denyHit.action).toBe("reject");

    const denyOther = evaluator.evaluate("材化2211 张三", {
      ...base,
      denyColleges: ["计算机学院"],
    });
    expect(denyOther.matched).toBe(true);
    expect(denyOther.action).toBe("approve");

    // 硬约束不能被 auto_approve 绕过
    const autoApproveBlocked = evaluator.evaluate("材化2211 张三", {
      ...base,
      mode: "auto_approve",
      denyColleges: ["化学与生命科学学院"],
    });
    expect(autoApproveBlocked.action).toBe("reject");

    // manual 模式仍交人工，只在意见里标明原因
    const manualBlocked = evaluator.evaluate("材化2211 张三", {
      ...base,
      mode: "manual",
      denyColleges: ["化学与生命科学学院"],
    });
    expect(manualBlocked.matched).toBe(false);
    expect(manualBlocked.action).toBe("manual");
    expect(manualBlocked.opinion).toContain("学院黑名单");
  });

  it("treats 班级库四位年份与面板两位写法为同一年级", () => {
    const base = {
      mode: "approve_on_match",
      requireClass: false,
      requireName: false,
      opinionEnabled: true,
    } as const;

    // 班级库存的是 2022，规则面板存的是 22
    const hit = evaluator.evaluate("材化2211 张三", { ...base, allowYears: ["22"] });
    expect(hit.matched).toBe(true);
    expect(hit.action).toBe("approve");

    // 四位写法同样能匹配
    const hitFour = evaluator.evaluate("材化2211 张三", { ...base, allowYears: ["2022"] });
    expect(hitFour.matched).toBe(true);

    const miss = evaluator.evaluate("材化2211 张三", { ...base, allowYears: ["24"] });
    expect(miss.matched).toBe(false);
    expect(miss.missing.join()).toContain("年级白名单");
    expect(miss.action).toBe("reject");

    const denyHit = evaluator.evaluate("材化2211 张三", {
      ...base,
      denyYears: ["22"],
    });
    expect(denyHit.matched).toBe(false);
    expect(denyHit.action).toBe("reject");
  });

  it("fails the allow list when the roster cannot identify college / year", () => {
    const base = {
      mode: "approve_on_match",
      requireClass: false,
      requireName: false,
      opinionEnabled: true,
    } as const;

    // 计科2201 在班级库里没有 classInfo → 拿不到学院 / 年级
    const allow = evaluator.evaluate("计科2201 李四", {
      ...base,
      allowColleges: ["化学与生命科学学院"],
    });
    expect(allow.matched).toBe(false);
    expect(allow.missing.join()).toContain("未识别到学院");

    // 只配黑名单时，识别不到就不拦
    const denyOnly = evaluator.evaluate("计科2201 李四", {
      ...base,
      denyColleges: ["化学与生命科学学院"],
    });
    expect(denyOnly.matched).toBe(true);
    expect(denyOnly.action).toBe("approve");
  });

  it("treats roster lists as configured rules and needs the roster", () => {
    // 只配名单也算「已配置规则」，不再报「未配置入群审核规则」
    const configured = evaluator.evaluate("材化2211 张三", {
      mode: "approve_on_match",
      requireClass: false,
      requireName: false,
      denyColleges: ["计算机学院"],
      opinionEnabled: true,
    });
    expect(configured.configIssue).toBeUndefined();

    // 没有班级库时：名单筛选无法判定 → 配置问题 + 人工
    const withoutRoster = new JoinRuleEvaluator(undefined);
    const result = withoutRoster.evaluate("材化2211 张三", {
      mode: "approve_on_match",
      requireClass: false,
      requireName: false,
      allowYears: ["22"],
      opinionEnabled: true,
    });
    expect(result.matched).toBe(false);
    expect(result.configIssue).toContain("班级库未加载");
    expect(result.missing.join()).toContain("学院 / 年级");
    expect(result.action).toBe("manual");
  });
});
