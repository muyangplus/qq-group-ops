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

  it("重启流程的接线：排好助手后回写部署监测 + 单飞闸（重复重启回归）", () => {    // 背景：真机报「一次部署改版两次」「手动重启后又自己重启一次」（0.25.0 的 P0 BUG，
    // 见 CHANGELOG 与 ADR-0061）。手动 /restart 与部署自动重启都走 runRestartFlow：
    // ① 排好 respawn 助手后必须回写 `markScheduled`，否则旧进程退出窗口里部署监测会再排一轮；
    // ② 同一时刻只允许一条流程，免得撞车拉起两个 `scripts/respawn.mjs`、写两条重启回执。
    const source = readFileSync(
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("deployWatcher.markScheduled(targetVersion)");
    expect(source).toContain(
      "restart request ignored: another restart flow is running",
    );
  });

  /**
   * 单实例闸接线（ADR-0064）：真机上曾经**两份 `node dist/main.js` 同时跑**，
   * 一次部署各发一张「发现新版本」、各自重启一次（`ps` 里两个 pid 的父进程都是 1）。
   * 这条守卫钉住三件事：抢锁在**接数据库之前**、退出时放开、拒绝启动时留证据并非零退出。
   */
  it("单实例闸：接库之前抢锁、退出时放开、拒绝启动要留证据", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "utf8",
    );

    const acquireAt = source.indexOf("acquireInstanceLock({ version: runningVersionOf() })");
    const connectAt = source.indexOf("connectPersistence(settings)");
    expect(acquireAt).toBeGreaterThan(0);
    expect(connectAt).toBeGreaterThan(0);
    // 必须在连库 / 连网关之前挡住第二份（否则它已经抢了端口、连着同一个 SQLite）
    expect(acquireAt).toBeLessThan(connectAt);

    expect(source).toContain("releaseInstanceLock();");
    expect(source).toContain("writeDuplicateEvidence(");
    expect(source).toContain("duplicate bot instance detected: refusing to start");
    // 以非零退出码结束，别让「拒绝启动」看起来像正常退出
    expect(source).toContain("process.exitCode = 1;");
  });

  /**
   * 自检进程不参与单实例锁（0.27.1 的真机事故）：`--check` 只是「跑一遍加载」，
   * 旧进程还活着时它一抢锁就被拒 → 退出码 1 → 「自检 JSON ok:true 但退出码 1」→
   * 重启被取消、**健康的新构建被回滚**，版本再也升不上去。
   */
  it("自检进程不抢单实例锁（否则健康的新版本会被自己拦下并回滚）", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("const instanceLock = isStartupCheck()");
    expect(source).toContain("? { ok: true as const }");
  });

  /**
   * `.env` 热改项的一次性导入接线（ADR-0066）。
   *
   * 三件事必须同时成立：
   * ① 导入在 `isStartupCheck()` 早退**之后** —— 自检是只读演练，绝不能写库；
   * ② 导入失败（写不进去）**不能拦住启动**：库里旧值 + 内置默认照样能跑；
   * ③ 真的导入了要留痕：`platform_config_import` 审计 + 私信回执（`.env` 里可以删行了）。
   */
  it("配置导入接线：在自检早退之后、失败不拦启动、写审计 + 私信回执", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "utf8",
    );
    const checkAt = source.indexOf("if (isStartupCheck()) {");
    const importAt = source.indexOf("await importEnvSettingsOnce(");
    expect(checkAt).toBeGreaterThan(0);
    expect(importAt).toBeGreaterThan(checkAt);
    expect(source).toContain(
      "env setting import failed (keeping database values)",
    );
    expect(source).toContain('action: "platform_config_import"');
    expect(source).toContain("配置已从 .env 导入");
  });
});