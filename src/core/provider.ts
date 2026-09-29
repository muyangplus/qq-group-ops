/**
 * 「值或取值函数」的统一写法（热配置用）。
 *
 * 需要热改的配置项不能在建对象时固化：服务保存的是 `Provider<T>`，在**用的时候**
 * 调 `valueOf()` 取当前值。这样老调用方直接传字面量也照旧工作（测试基本不用改）。
 */
export type Provider<T> = T | (() => T);

export function valueOf<T>(provider: Provider<T>): T {
  return typeof provider === "function" ? (provider as () => T)() : provider;
}
