/**
 * 确定性字符串排序（中文优先）。
 *
 * 为什么不能直接写 `a.localeCompare(b)`：**不指定 locale 时 ICU 会用运行环境的默认 locale**
 * （`LANG` / `LC_ALL` / 系统区域设置），同一份代码在不同机器、不同 CI runner 上可能排出不同顺序。
 * 真机踩过：本地（中文系统）`甲 < 乙`，GitHub runner（默认 en-US）却排出 `乙 < 甲`，
 * 于是 `test/activityStats.test.ts` 在 CI 上失败 —— 测试没错，是实现依赖了环境。
 *
 * 这里的做法：
 * 1. 显式钉住 `zh-Hans-CN`（ICU 中文默认拼音排序：`甲(jiǎ) < 乙(yǐ)`），并开 `numeric`，
 *    让「2 班」排在「10 班」前面；
 * 2. 运行环境是 small-icu（不含中文排序数据）时退化为**码点比较** —— 顺序虽不符合拼音，
 *    但仍是**跨环境确定**的，不会让测试随环境漂移。
 */

/** 优先使用中文排序；`Intl` 不可用或缺少中文数据时为 `undefined`（退化到码点比较）。 */
const collator: Intl.Collator | undefined = (() => {
  try {
    if (
      typeof Intl === "undefined" ||
      typeof Intl.Collator !== "function" ||
      Intl.Collator.supportedLocalesOf(["zh-Hans-CN"]).length === 0
    ) {
      return undefined;
    }
    return new Intl.Collator("zh-Hans-CN", {
      usage: "sort",
      numeric: true,
      sensitivity: "variant",
    });
  } catch {
    return undefined;
  }
})();

/** 是否在用中文排序（日志/排查用）。 */
export const usingChineseCollation = collator !== undefined;

/**
 * 标签排序比较器：人数相同时用它排名称。
 *
 * 用它代替裸 `localeCompare`，保证**同一份数据在哪台机器上都排出同样的顺序**。
 */
export function compareLabels(left: string, right: string): number {
  if (collator) {
    return collator.compare(left, right);
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
