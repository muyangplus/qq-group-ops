/**
 * 列表排序：**最新的在前**（列表卡片统一口径）。
 *
 * 为什么不用 `items.sort((a, b) => timeOf(b) - timeOf(a))`：
 * `Array.prototype.sort` 是**稳定**的，并列时保留入参顺序；而这些列表都来自 `Map.values()`
 * （插入顺序 = 创建顺序，旧的在前），于是**同一毫秒创建的两条会以「旧的在前」返回** ——
 * 顺序随机器快慢抖动，GitHub CI 上真的因此红过一次（`punishAppeal` 的原文保留用例）。
 *
 * 这里先按时间**升序**（稳定，并列时仍是创建顺序）再整体反转，并列项就变成「后创建的在前」，
 * 于是「同一毫秒」不再是未定义行为，测试与真机表现一致。
 */
export function newestFirst<T>(
  items: Iterable<T>,
  timeOf: (item: T) => number,
): T[] {
  const sorted = [...items];
  sorted.sort((left, right) => timeOf(left) - timeOf(right));
  sorted.reverse();
  return sorted;
}
