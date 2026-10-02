import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FakeQueryable } from "./helpers/fakeQueryable.js";
import { createPersistentRuntime } from "./helpers/persistenceRuntime.js";

/**
 * 装配完整性（回归）：`/data` 与管理 API 依赖的仓储必须真的接上。
 *
 * 背景：0.23.0 的生产装配（`main.ts`）是**逐个列举**仓储键的，漏了 `privacy` 与 `adminTokens`，
 * 于是真机上 `/data delete` 报「功能未装配」、`ADMIN_API_ENABLED=true` 也起不来监听口
 * （日志还把它误导成「没有数据库」）。测试替身漏得更多（7 个）。现在装配只发生在
 * `createRepositories()` 一处，这个用例把「整份透传 → 两个功能都可用」钉住。
 */
describe("runtime 仓储装配完整性", () => {
  it("测试替身覆盖全部仓储：/data 已装配", () => {
    const runtime = createPersistentRuntime(new FakeQueryable());

    // 以前这里 configured === false（`repositories.privacy` 没传）
    expect(runtime.privacy.configured).toBe(true);
  });

  it("开着管理 API 时，整份透传能让监听口拿到令牌仓储", () => {
    const previous = {
      ADMIN_API_ENABLED: process.env["ADMIN_API_ENABLED"],
      ADMIN_API_SESSION_SECRET: process.env["ADMIN_API_SESSION_SECRET"],
    };
    process.env["ADMIN_API_ENABLED"] = "true";
    process.env["ADMIN_API_SESSION_SECRET"] =
      "wiring-test-session-secret-abcdefghijklmnop";
    try {
      const runtime = createPersistentRuntime(new FakeQueryable());

      // 以前这里是 undefined → main.ts 跳过监听口（真机上就是这么发生的）
      expect(runtime.adminApiHost).toBeDefined();
      expect(runtime.adminApiHost?.tokens).toBeDefined();
      // 写端点背后的领域服务也装上了
      expect(typeof runtime.adminApiHost?.backend.approveJoin).toBe("function");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("假模式退出前必须先关管理 API 监听口，再关数据库", () => {
    // 背景：假模式（没有 QQ 凭据）在 main.ts 里 `return` 之前会 flush + close 数据库。
    // 管理 API 监听口是在那之前起的 —— 如果先关库、后关（或漏关）监听口，
    // 监听口会把事件循环留住，进程不退出，然后所有读库的接口都 500 `database is not open`。
    const source = readFileSync(
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "utf8",
    );
    const fakeBlock = source.slice(
      source.indexOf('if (runtime.mode === "fake")'),
      source.indexOf("// 统一计时"),
    );

    expect(fakeBlock).toContain("adminApiHost?.close()");
    expect(fakeBlock.indexOf("adminApiHost?.close()")).toBeLessThan(
      fakeBlock.indexOf("persistence?.close()"),
    );
  });
});
