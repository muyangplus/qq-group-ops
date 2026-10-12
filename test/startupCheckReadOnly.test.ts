import { describe, expect, it } from "vitest";

import { NOTIFY_SCOPE_ALL } from "../src/services/notifications.js";
import { createPersistentRuntime } from "./helpers/persistenceRuntime.js";
import { createSqliteTestDatabase } from "./helpers/testDatabases.js";

/**
 * 自检只读（ADR-0069）：`node dist/main.js --check` 会跑 `runtime.load()`，
 * 所以 **`load()` 不能写任何持久化状态**。
 *
 * 背景（真机踩过）：原来的 `load()` 里有「给现有超管补默认通知订阅」（`seedSuperAdminDefaults`），
 * 一次 `--check` 就给 `notification_subscriptions` 插了 6 行 —— 自检的语义是
 * 「这份构建能不能起来」的只读演练，不该顺手改状态。
 *
 * 现在那一笔挪到 `main.ts` 的正常启动路径上（**自检早退之后**），只能由
 * `runtime.seedSuperAdminNotifications()` 显式触发。
 */
describe("自检只读：load() 不补超管默认订阅（ADR-0069）", () => {
  /** 超管专属话题之一（`defaultLevel >= 平台档下限`，种的就是它这一批）。 */
  const TOPIC = "bot_join";

  it("只跑 load() 不写订阅行；显式调用才补、能落库、且幂等", async () => {
    const database = await createSqliteTestDatabase();
    try {
      const runtime = createPersistentRuntime(database.queryable, "root");
      await runtime.load();

      // ① 自检走的就是「load() 完就退出」这条路：订阅表一行都不写
      expect(
        runtime.notifications.isSubscribed("root", NOTIFY_SCOPE_ALL, TOPIC),
      ).toBe(false);

      // ② 正常启动路径：显式补 + flush 落库
      expect(runtime.seedSuperAdminNotifications()).toBeGreaterThan(0);
      await runtime.flush();
      expect(
        runtime.notifications.isSubscribed("root", NOTIFY_SCOPE_ALL, TOPIC),
      ).toBe(true);

      // ③ 换一份进程读同一个库：行还在（确实落库了）；再补一次幂等（0 行）
      const restarted = createPersistentRuntime(database.queryable, "root");
      await restarted.load();
      expect(
        restarted.notifications.isSubscribed("root", NOTIFY_SCOPE_ALL, TOPIC),
      ).toBe(true);
      expect(restarted.seedSuperAdminNotifications()).toBe(0);
    } finally {
      await database.cleanup();
    }
  });
});
