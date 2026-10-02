import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appVersion } from "../src/core/buildInfo.js";
import {
  PREFLIGHT_SUMMARY_INLINE_MAX,
  inlineSummary,
  preflightFailedCard,
  restartDoneCard,
  takeRestartNotice,
  writeRestartNotice,
} from "../src/services/restartNotice.js";

/**
 * 重启回执：`/restart` 退出前写一行文件，新进程起来读走它并私信发起人 ——
 * 这是「进程管理器真的把机器人拉回来了」的自证手段。
 */
function tempFile(name: string): string {
  return join(tmpdir(), `qqops-restart-notice-${name}.json`);
}

describe("restartNotice", () => {
  it("写入 → 读走（含删除）→ 再读为空", () => {
    const file = tempFile("roundtrip");
    const notice = {
      userId: "root",
      requestedAt: "2026-09-27T14:00:00.000Z",
      version: "0.19.0",
    };

    expect(writeRestartNotice(notice, file)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(takeRestartNotice(file)).toEqual(notice);
    expect(existsSync(file)).toBe(false);
    expect(takeRestartNotice(file)).toBeUndefined();
  });

  it("坏 JSON / 缺字段都当没有，并且文件会被清掉", () => {
    const broken = tempFile("broken");
    writeFileSync(broken, "{不是 json", "utf8");
    expect(takeRestartNotice(broken)).toBeUndefined();
    expect(existsSync(broken)).toBe(false);

    const missing = tempFile("missing");
    writeFileSync(missing, JSON.stringify({ version: "0.19.0" }), "utf8");
    expect(takeRestartNotice(missing)).toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });

  it("版本缺失时回落 unknown，不抛错", () => {
    const file = tempFile("noversion");
    writeFileSync(
      file,
      JSON.stringify({ userId: "root", requestedAt: "2026-09-27T14:00:00.000Z" }),
      "utf8",
    );
    expect(takeRestartNotice(file)).toEqual({
      userId: "root",
      requestedAt: "2026-09-27T14:00:00.000Z",
      version: "unknown",
    });
  });

  it("回执卡带版本、启动时间与耗时", () => {
    const card = restartDoneCard(
      {
        userId: "root",
        requestedAt: new Date(Date.now() - 5_000).toISOString(),
        version: "0.18.2",
        reason: "manual",
      },
      appVersion(),
    );
    expect(card.markdown).toContain("机器人已重启");
    expect(card.markdown).toContain(`v${appVersion()}`);
    expect(card.markdown).toContain("重启前 v0.18.2");
    expect(card.markdown).toContain("请求到启动");
  });

  it("部署自动重启的回执：说清新旧版本", () => {
    const card = restartDoneCard(
      {
        userId: "deploy-watcher",
        requestedAt: new Date(Date.now() - 3_000).toISOString(),
        version: "0.20.0",
        targetVersion: "0.21.0",
        reason: "deploy",
        mode: "respawn",
      },
      "0.21.0",
    );
    expect(card.markdown).toContain("新版本已上线");
    expect(card.markdown).toContain("v0.20.0 → **v0.21.0**");
    expect(card.markdown).toContain("自我重启");
  });

  it("请求时间不可解析时也不崩（只是不显示耗时）", () => {
    const card = restartDoneCard(
      { userId: "root", requestedAt: "不是时间", version: "0.19.0" },
      "0.19.0",
    );
    expect(card.markdown).toContain("机器人已重启");
    expect(card.markdown).not.toContain("请求到启动");
  });
});

/**
 * 「重启已取消」卡（自检没过时）。
 *
 * 用户口径：**这时候要把 `data/startup-check.json` 发过来**（内联一段 + 一个「自检结果」按钮给全文），
 * 并且说清「手动重试不限次数」——那条「同一版本只试一次」的限制只作用于部署监测的自动重试。
 */
describe("preflightFailedCard", () => {
  const base = {
    targetVersion: "0.24.0",
    reason: "自检退出码 1（详见 data/startup-check.json）",
    restore: { ok: true, detail: "坏构建已挪到 data/dist-broken，并从快照还原 dist" },
  };

  it("说清三件事：还在跑上一版 / 为什么没过 / 手动重试不限次数", () => {
    const card = preflightFailedCard({
      ...base,
      summary: { ok: false, error: "database is not open" },
    });

    expect(card.markdown).toContain("重启已取消");
    expect(card.markdown).toContain("机器人仍在运行上一版");
    expect(card.markdown).toContain("**新版本**：v0.24.0");
    expect(card.markdown).toContain("database is not open");
    expect(card.markdown).toContain("手动重试不限次数");
    expect(card.markdown).toContain("**自动重试**对同一版本只试一次");
  });

  it("内联自检原文，并把完整内容的入口做成按钮", () => {
    const card = preflightFailedCard({
      ...base,
      summary: { ok: false, error: "boom", at: "2026-10-02T07:20:00.000Z" },
    });
    const keyboard = JSON.stringify(card.keyboard);

    expect(card.markdown).toContain("data/startup-check.json");
    expect(card.markdown).toContain('"error":"boom"');
    // 四个出口 + 进程状态：重新检查并重启 / 自检结果 / 强制重启 / 再次检查 / 看看进程状态
    expect(keyboard).toContain("cb:restart:go");
    expect(keyboard).toContain("cb:restart:detail");
    expect(keyboard).toContain("cb:restart:force");
    expect(keyboard).toContain("cb:restart:again");
    expect(keyboard).toContain("cb:status:proc");
    expect(card.markdown).toContain("重新检查并重启");
    expect(card.markdown).toContain("自检结果");
  });

  it("读不到自检文件时明确说明，而不是留一行空白", () => {
    const card = preflightFailedCard(base);

    expect(card.markdown).toContain("读不到 data/startup-check.json");
  });

  it("回滚失败也如实说（不让人以为已经换回上一版）", () => {
    const card = preflightFailedCard({
      ...base,
      restore: { ok: false, detail: "没有可回滚的构建快照" },
    });

    expect(card.markdown).toContain("换回上一版没成功");
    expect(card.markdown).toContain("没有可回滚的构建快照");
  });

  it("inlineSummary：超长截断并提示点按钮看全文", () => {
    const long = { ok: false, error: "x".repeat(PREFLIGHT_SUMMARY_INLINE_MAX + 50) };

    const text = inlineSummary(long);

    expect(text.length).toBeLessThan(PREFLIGHT_SUMMARY_INLINE_MAX + 40);
    expect(text.endsWith("（完整内容点「自检结果」）")).toBe(true);
    expect(inlineSummary({ ok: true })).toBe('{"ok":true}');
  });
});
