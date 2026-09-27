import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appVersion } from "../src/core/buildInfo.js";
import {
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
      },
      appVersion(),
    );
    expect(card.markdown).toContain("机器人已重启");
    expect(card.markdown).toContain(`v${appVersion()}`);
    expect(card.markdown).toContain("请求时 v0.18.2");
    expect(card.markdown).toContain("请求到启动");
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
