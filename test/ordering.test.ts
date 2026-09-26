import { describe, expect, it } from "vitest";

import { newestFirst } from "../src/core/ordering.js";

/**
 * 列表「最新在前」的统一口径：同毫秒也不能抖。
 *
 * 背景：这些列表来自 `Map.values()`（插入顺序 = 创建顺序），
 * 直接用 `sort((a, b) => timeOf(b) - timeOf(a))` 时并列项会保留原顺序（旧的在前），
 * 导致 GitHub CI 上 `punishAppeal` 的原文保留用例间歇性失败。
 */
describe("newestFirst", () => {
  interface Item {
    id: string;
    at: number;
  }
  const at = (item: Item): number => item.at;

  it("sorts strictly by time, newest first", () => {
    const items: Item[] = [
      { id: "a", at: 1_000 },
      { id: "b", at: 3_000 },
      { id: "c", at: 2_000 },
    ];
    expect(newestFirst(items, at).map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps the later-inserted item first when timestamps tie", () => {
    // 三条同一毫秒：插入顺序 a → b → c，期望「后插入的在前」
    const items: Item[] = [
      { id: "a", at: 5_000 },
      { id: "b", at: 5_000 },
      { id: "c", at: 5_000 },
    ];
    expect(newestFirst(items, at).map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("handles ties mixed with distinct timestamps", () => {
    const items: Item[] = [
      { id: "old", at: 1 },
      { id: "same-1", at: 9 },
      { id: "same-2", at: 9 },
      { id: "middle", at: 5 },
    ];
    expect(newestFirst(items, at).map((item) => item.id)).toEqual([
      "same-2",
      "same-1",
      "middle",
      "old",
    ]);
  });

  it("does not mutate the input and accepts any iterable", () => {
    const items: Item[] = [
      { id: "a", at: 2 },
      { id: "b", at: 1 },
    ];
    const map = new Map(items.map((item) => [item.id, item]));
    expect(newestFirst(map.values(), at).map((item) => item.id)).toEqual(["a", "b"]);
    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(newestFirst([], at)).toEqual([]);
  });
});
