import { describe, expect, it } from "vitest";

import {
  currentDisplayTimeZone,
  DEFAULT_DISPLAY_TIME_ZONE,
  formatDisplayTime,
  formatLogTime,
  setDisplayTimeZone,
} from "../src/core/timeFormat.js";

/**
 * 展示时区（用户口径）：默认 UTC+8，env 可覆盖；库里仍存 UTC。
 */
const INSTANT = new Date("2026-09-26T14:15:58.884Z");

describe("timeFormat", () => {
  it("默认按 UTC+8 展示卡片与日志时间", () => {
    expect(DEFAULT_DISPLAY_TIME_ZONE).toBe("Asia/Shanghai");
    expect(setDisplayTimeZone(undefined)).toBe(true);
    expect(currentDisplayTimeZone()).toBe("Asia/Shanghai");
    // 14:15:58Z → 22:15:58（+08:00）
    expect(formatDisplayTime(INSTANT)).toBe("2026-09-26 22:15:58");
    expect(formatLogTime(INSTANT)).toBe("2026-09-26T22:15:58.884+08:00");
  });

  it("支持 env 覆盖到别的时区", () => {
    expect(setDisplayTimeZone("UTC")).toBe(true);
    expect(formatDisplayTime(INSTANT)).toBe("2026-09-26 14:15:58");
    expect(formatLogTime(INSTANT)).toBe("2026-09-26T14:15:58.884+00:00");
    expect(setDisplayTimeZone("America/New_York")).toBe(true);
    expect(formatLogTime(INSTANT)).toBe("2026-09-26T10:15:58.884-04:00");
  });

  it("非法时区回落到 UTC+8 并返回 false", () => {
    expect(setDisplayTimeZone("Not/AZone")).toBe(false);
    expect(currentDisplayTimeZone()).toBe("Asia/Shanghai");
    expect(formatDisplayTime(INSTANT)).toBe("2026-09-26 22:15:58");
  });
});
