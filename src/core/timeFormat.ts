/**
 * 展示时区（卡片时间 + 日志时间）。
 *
 * 用户口径：**默认 UTC+8**（`Asia/Shanghai`），可用 env `TZ`（或 `TIMEZONE`）覆盖。
 *
 * - 数据库里**依旧存 UTC ISO**（`toISOString()`），只有展示层与日志换时区；
 * - 时区固定写死/由 env 注入，**不依赖宿主/容器时区**（否则本地与 CI 显示不一致，
 *   这类「跨环境不一致」在本项目已经踩过一次：中文排序用了宿主 locale）；
 * - 本模块**不 import logger**（logger 反过来要用它格式化日志时间，避免循环依赖）；
 *   非法时区的回落由调用方决定是否打日志。
 */

export const DEFAULT_DISPLAY_TIME_ZONE = "Asia/Shanghai";

let displayTimeZone = DEFAULT_DISPLAY_TIME_ZONE;

/** 设置展示时区；返回是否采纳（`false` = 值非法，已回落默认）。 */
export function setDisplayTimeZone(timeZone: string | undefined): boolean {
  const trimmed = timeZone?.trim() ?? "";
  if (trimmed.length === 0) {
    displayTimeZone = DEFAULT_DISPLAY_TIME_ZONE;
    return true;
  }
  try {
    // 非法时区会在 format 时抛 RangeError
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date(0));
    displayTimeZone = trimmed;
    return true;
  } catch {
    displayTimeZone = DEFAULT_DISPLAY_TIME_ZONE;
    return false;
  }
}

export function currentDisplayTimeZone(): string {
  return displayTimeZone;
}

/** 卡片时间：`2026-09-26 22:15:58`（展示时区）。 */
export function formatDisplayTime(date: Date): string {
  return `${dateParts(date)}`;
}

/** 日志时间：`2026-09-26T22:15:58.884+08:00`（带偏移、可解析、无歧义）。 */
export function formatLogTime(date: Date): string {
  const millis = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${dateParts(date).replace(" ", "T")}.${millis}${offsetSuffix(date)}`;
}

function dateParts(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: displayTimeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** 该时刻在展示时区相对 UTC 的偏移，形如 `+08:00`。 */
function offsetSuffix(date: Date): string {
  const local = new Date(`${dateParts(date).replace(" ", "T")}Z`);
  const minutes = Math.round((local.getTime() - date.getTime()) / 60_000);
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const rest = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${rest}`;
}
