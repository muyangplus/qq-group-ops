import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isStartupCheck,
  readStartupCheckFile,
  STARTUP_CHECK_FLAG,
  writeStartupCheckFile,
} from "../src/startupCheck.js";

/** 层 4A：自检模式的开关识别与结果文件（助手只读这个文件）。 */
describe("startupCheck", () => {
  it("识别 --check（其余参数不影响）", () => {
    expect(isStartupCheck(["node", "dist/main.js", STARTUP_CHECK_FLAG])).toBe(true);
    expect(isStartupCheck(["node", "dist/main.js"])).toBe(false);
    expect(isStartupCheck([])).toBe(false);
  });

  it("写入后能读回，并带上时间戳", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-check-"));
    const file = join(dir, "nested", "startup-check.json");
    try {
      writeStartupCheckFile({ ok: true, degraded: [], migrationIssues: [] }, file);
      const parsed = readStartupCheckFile(file);
      expect(parsed).toMatchObject({ ok: true });
      expect(typeof parsed?.at).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败结果也能落盘（ok:false + 原因）", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-check-"));
    const file = join(dir, "startup-check.json");
    try {
      writeStartupCheckFile({ ok: false, error: "无法初始化 SQLite schema" }, file);
      expect(readStartupCheckFile(file)).toMatchObject({
        ok: false,
        error: "无法初始化 SQLite schema",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件缺失 / 坏 JSON 时返回 undefined（不抛错）", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-check-"));
    try {
      expect(readStartupCheckFile(join(dir, "nope.json"))).toBeUndefined();
      const broken = join(dir, "broken.json");
      writeFileSync(broken, "{不是 JSON", "utf8");
      expect(readStartupCheckFile(broken)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
