import { describe, expect, it } from "vitest";

import { compareLabels, usingChineseCollation } from "../src/core/collation.js";

/**
 * 确定性排序回归（CI 上翻过车）。
 *
 * 原来 `distributionOf` 直接用裸 `localeCompare`：不指定 locale 时 ICU 用**运行环境默认 locale**，
 * 本地中文系统排出「甲 → 乙」，GitHub runner（en-US）排出「乙 → 甲」，于是
 * `test/activityStats.test.ts` 在 CI 上失败。现在统一走 `compareLabels`（显式钉 zh-Hans-CN）。
 */
describe("compareLabels", () => {
  it("sorts Chinese labels by pinyin, not by host locale", () => {
    // zh 拼音：甲(jiǎ) < 乙(yǐ) —— 与运行环境的 LANG/LC_ALL 无关
    expect(compareLabels("甲", "乙")).toBeLessThan(0);
    expect(compareLabels("乙", "甲")).toBeGreaterThan(0);
    expect(compareLabels("甲", "甲")).toBe(0);
  });

  it("is a consistent total order (sign-symmetric)", () => {
    const samples = ["甲", "乙", "丙", "材化2211", "环工2314", "（未填）", "A", "a", "1"];
    for (const left of samples) {
      for (const right of samples) {
        // 注意用 `===`：0 与 -0 在 Object.is 下不等，但这里语义相同
        expect(compareLabels(left, right) === -compareLabels(right, left)).toBe(
          true,
        );
      }
    }
  });

  it("sorts numbers inside labels numerically when Chinese collation is available", () => {
    if (!usingChineseCollation) {
      // small-icu 环境退化为码点比较，此时只保证确定性与对称性
      expect(["1", "2", "10"].sort(compareLabels)).toEqual(["1", "10", "2"]);
      return;
    }
    // numeric: true —— 「2 班」排在「10 班」前面
    expect(["10班", "2班", "1班"].sort(compareLabels)).toEqual([
      "1班",
      "2班",
      "10班",
    ]);
  });
});
