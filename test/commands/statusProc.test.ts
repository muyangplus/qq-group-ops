import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../../src/adapters/fakeQqOfficial.js";
import { loadSettings } from "../../src/config.js";
import { WriteQueue } from "../../src/db/writeQueue.js";
import type { AdminCommandContext } from "../../src/services/commands/context.js";
import { processCard } from "../../src/services/commands/statusCommands.js";
import { JoinAuditService } from "../../src/services/joinAudit.js";
import { NotificationService } from "../../src/services/notifications.js";
import { PermissionService } from "../../src/services/permissions.js";
import { service } from "../helpers/adminCommandsHarness.js";

/** 手工拼一个只含 `/status proc` 需要的那几项的上下文（测试用）。 */
function contextWith(env: NodeJS.ProcessEnv): AdminCommandContext {
  const permissions = new PermissionService({
    superAdminIds: new Set(["root"]),
  });
  return {
    permissions,
    joinAudit: new JoinAuditService(),
    notifications: new NotificationService(new FakeQQOfficialAPI(), permissions),
    diagnostics: { settings: loadSettings(env), writeQueue: new WriteQueue() },
  } as unknown as AdminCommandContext;
}

/**
 * `/status` 的进程维度：群状态卡带**一行精简**进程信息，`/status proc` 出**全套详情**（仅全局超管）。
 */
describe("AdminCommandService · /status 进程信息", () => {
  it("群状态卡带精简进程行；「进程」按钮只对超管渲染", async () => {
    const mod = await service.handle("g1", "mod", "/status");
    expect(mod.ok).toBe(true);
    expect(mod.rich.markdown).toContain("**进程**：v");
    expect(mod.rich.markdown).toContain("已运行");
    expect(mod.rich.markdown).toContain("内存");
    expect(JSON.stringify(mod.rich.keyboard)).not.toContain("cb:status:proc");

    const root = await service.handle("g1", "root", "/status");
    expect(root.rich.markdown).toContain("**进程**：v");
    expect(JSON.stringify(root.rich.keyboard)).toContain("cb:status:proc");
  });

  it("/status proc：非超管被拒，超管能看到全套字段", async () => {
    const denied = await service.handle("g1", "admin", "/status proc");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("只有全局超管");

    const card = await service.handle("g1", "root", "/status proc");
    expect(card.ok).toBe(true);
    const text = card.rich.markdown;
    for (const field of [
      "**版本**：v",
      "**启动时间**：",
      "**运行环境**：Node",
      "**内存占用**：",
      "**运行模式**：",
      "**数据库**：",
      "**待写数据库**：",
      "**通知订阅**：",
      "**待审批申请**：",
      "**日志与保留**：",
      "**管理员**：",
    ]) {
      expect(text, field).toContain(field);
    }
    expect(JSON.stringify(card.rich.keyboard)).toContain("cb:status:proc");
  });

  it("别名可用，私信里也能查（sys / 诊断）", async () => {
    const byAlias = await service.handle(undefined, "root", "/status 诊断");
    expect(byAlias.ok).toBe(true);
    expect(byAlias.rich.markdown).toContain("**版本**：v");

    const bySys = await service.handle(undefined, "root", "/status sys");
    expect(bySys.ok).toBe(true);
    expect(bySys.rich.markdown).toContain("**待写数据库**：");
  });

  it("postgres 只显示 host/db，绝不把 URL 里的口令打出来", () => {
    const card = processCard(
      contextWith({
        DATABASE_URL: "postgres://ops:supersecret@db.example.com:5432/qqops",
      }),
      "root",
    );
    expect(card.ok).toBe(true);
    expect(card.rich.markdown).toContain("db.example.com/qqops");
    expect(card.rich.markdown).not.toContain("supersecret");
    expect(card.rich.markdown).toContain("口令已隐藏");
  });

  it("sqlite / memory 各自的写法", () => {
    const sqlite = processCard(
      contextWith({ SQLITE_PATH: "data/test-status.db" }),
      "root",
    );
    expect(sqlite.rich.markdown).toContain("sqlite · data/test-status.db");

    const memory = processCard(
      contextWith({ DATABASE_URL: "sqlite::memory:" }),
      "root",
    );
    expect(memory.rich.markdown).toContain("memory（不落盘）");
  });
});
