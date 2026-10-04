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

  it("进程卡带构建自证（ADR-0065）：指纹 / commit 有就显示，没有就如实说", () => {
    const card = processCard(contextWith({}), "root");
    expect(card.ok).toBe(true);
    // 测试进程没有 `dist/build-info.json`（源码运行）→ 如实说明，而不是编一个指纹
    expect(card.rich.markdown).toContain("**构建自证**：");
  });

  it("有上一个包时给「回滚上一版」按钮（带官方二次确认弹窗）；没有就不渲染", () => {
    const base = contextWith({});
    const withTarget = {
      ...base,
      install: {
        rollbackTarget: () => ({
          version: "0.20.0",
          currentVersion: "0.21.0",
          sha256: "abc",
        }),
        appliedVersion: () => "0.21.0",
        rollback: async () => ({
          ok: true,
          version: "0.20.0",
          code: "ok" as const,
          message: "ok",
        }),
      },
    } as unknown as AdminCommandContext;

    const card = processCard(withTarget, "root");
    expect(card.ok).toBe(true);
    expect(card.rich.markdown).toContain("**可回滚**：v0.20.0");
    const keyboard = JSON.stringify(card.rich.keyboard);
    expect(keyboard).toContain("cb:deploy:rollback");
    // 二次确认弹窗：不可逆动作必须先弹官方 modal
    expect(keyboard).toContain("确认回滚 v0.21.0 → v0.20.0？");

    // 没有可回滚版本：不渲染按钮、也不显示那一行
    const withoutTarget = {
      ...base,
      install: {
        rollbackTarget: () => undefined,
        appliedVersion: () => "0.21.0",
        rollback: async () => ({
          ok: false,
          version: "",
          code: "no_target" as const,
          message: "no",
        }),
      },
    } as unknown as AdminCommandContext;
    const bare = processCard(withoutTarget, "root");
    expect(JSON.stringify(bare.rich.keyboard)).not.toContain("cb:deploy:rollback");
    expect(bare.rich.markdown).not.toContain("**可回滚**");
  });

  it("没装配安装器时（纯单测 / 老装配）也不渲染回滚入口", () => {
    const card = processCard(contextWith({}), "root");
    expect(JSON.stringify(card.rich.keyboard)).not.toContain("cb:deploy:rollback");
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
