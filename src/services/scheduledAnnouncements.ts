import { randomUUID } from "node:crypto";

import { AuditStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { GroupSettingsRepository } from "../db/groupSettingsRepository.js";
import type { WriteQueue } from "../db/writeQueue.js";
import {
  CARD_MAX_BUTTONS_PER_ROW,
  CARD_MAX_ROW_TEXT_LENGTH,
  quoteCardLines,
  renderCard,
  type CardButton,
} from "./cardTemplate.js";
import { DEFAULT_PASSIVE_REPLY_WINDOW_MS } from "../adapters/passiveReplyQuota.js";
import type { AuditLog } from "./audit.js";
import type { RichMessage, RichSendResult } from "./richMessages.js";

const log = getLogger("scheduled-announcements");

/* -------------------------------------------------------------------------- */
/* cron（标准 5 段）                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 解析后的 cron（5 段：分 时 日 月 周）。
 *
 * 语义按**标准 cron**（本地时区）：
 * - `日` 与 `周` 都没限定时，任意一天都算命中；
 * - 只限定其中一个时，看那个字段；
 * - **两个都限定**时按「满足任一」——`0 0 1 * 1` = 每月 1 日**或**每周一。
 *   （这是 vixie cron 的既有语义，写进 ADR-0062，避免各人对齐不上。）
 */
export interface CronSpec {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

export type CronParseResult =
  | { ok: true; spec: CronSpec }
  | { ok: false; error: string };

/** 「下次执行时间」最多往后找多少天（约 25 年，够覆盖 5 次 2 月 29 日）。 */
const NEXT_SCAN_MAX_DAYS = 9_500;
/** 「下次执行时间」一次最多算几条（防前端传个大数把 CPU 拖住）。 */
export const MAX_NEXT_TIMES = 10;

type CronFieldParse =
  | { ok: true; values: number[]; wildcard: boolean }
  | { ok: false; error: string };

/**
 * 解析一个 cron 字段：支持 `*`、单值、区间 `a-b`、步长（星号或区间后接 `/n`）、逗号列表。
 *
 * 明确**不支持**名字（`MON` / `JAN`）与 `?` / `L` / `#` 这些扩展——报错时把人话写清楚，
 * 比「解析不出来」有用。
 */
function parseCronField(
  raw: string,
  min: number,
  max: number,
  name: string,
): CronFieldParse {
  const values = new Set<number>();
  let wildcard = false;
  for (const piece of raw.split(",")) {
    const part = piece.trim();
    if (part.length === 0) {
      return { ok: false, error: `${name}字段里有空的项：${raw}` };
    }
    const slash = part.indexOf("/");
    const body = slash >= 0 ? part.slice(0, slash) : part;
    const stepText = slash >= 0 ? part.slice(slash + 1) : undefined;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/u.test(stepText)) {
        return {
          ok: false,
          error: `${name}字段的步长要写正整数（收到：${stepText}）`,
        };
      }
      step = Number.parseInt(stepText, 10);
      if (step <= 0) {
        return { ok: false, error: `${name}字段的步长要 ≥1（收到：${stepText}）` };
      }
    }
    let start: number;
    let end: number;
    if (body === "*") {
      start = min;
      end = max;
      wildcard = true;
    } else if (body.includes("-")) {
      const [fromText = "", toText = "", ...rest] = body.split("-");
      if (rest.length > 0) {
        return { ok: false, error: `${name}字段的区间写法不对：${body}` };
      }
      const from = parseIntInRange(fromText, min, max);
      const to = parseIntInRange(toText, min, max);
      if (from === undefined || to === undefined) {
        return {
          ok: false,
          error: `${name}字段要写 ${min}–${max} 之间的整数（收到：${body}）`,
        };
      }
      if (from > to) {
        return { ok: false, error: `${name}字段的区间要从小到大（收到：${body}）` };
      }
      start = from;
      end = to;
    } else {
      const single = parseIntInRange(body, min, max);
      if (single === undefined) {
        return {
          ok: false,
          error: `${name}字段要写 ${min}–${max} 之间的整数（收到：${body}）`,
        };
      }
      start = single;
      // `5/10` = 从 5 开始、每 10 一个，直到字段上限（标准 cron 的写法）
      end = slash >= 0 ? max : single;
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  if (values.size === 0) {
    return { ok: false, error: `${name}字段没有解析出任何取值：${raw}` };
  }
  return { ok: true, values: [...values].sort((a, b) => a - b), wildcard };
}

function parseIntInRange(
  text: string,
  min: number,
  max: number,
): number | undefined {
  if (!/^\d+$/u.test(text)) {
    return undefined;
  }
  const value = Number.parseInt(text, 10);
  return value >= min && value <= max ? value : undefined;
}

/** 解析 5 段 cron（分 时 日 月 周）；失败给出可直接展示的中文原因。 */
export function parseCronExpression(expression: string): CronParseResult {
  const raw = expression.trim();
  if (raw.length === 0) {
    return { ok: false, error: "cron 不能为空，要写 5 段：分 时 日 月 周" };
  }
  if (raw.startsWith("@")) {
    return {
      ok: false,
      error: `不支持 ${raw} 这类宏，请写 5 段：分 时 日 月 周`,
    };
  }
  const fields = raw.split(/\s+/u);
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `cron 要正好 5 段（分 时 日 月 周），收到 ${fields.length} 段：${raw}`,
    };
  }
  const minute = parseCronField(fields[0] ?? "", 0, 59, "分钟");
  if (!minute.ok) {
    return minute;
  }
  const hour = parseCronField(fields[1] ?? "", 0, 23, "小时");
  if (!hour.ok) {
    return hour;
  }
  const day = parseCronField(fields[2] ?? "", 1, 31, "日");
  if (!day.ok) {
    return day;
  }
  const month = parseCronField(fields[3] ?? "", 1, 12, "月");
  if (!month.ok) {
    return month;
  }
  // 星期按「0 或 7 = 周日」解析，再统一归一到 0..6
  const week = parseCronField(fields[4] ?? "", 0, 7, "星期");
  if (!week.ok) {
    return week;
  }
  return {
    ok: true,
    spec: {
      minutes: minute.values,
      hours: hour.values,
      daysOfMonth: day.values,
      months: month.values,
      daysOfWeek: [...new Set(week.values.map((value) => (value === 7 ? 0 : value)))].sort(
        (a, b) => a - b,
      ),
      domRestricted: !day.wildcard,
      dowRestricted: !week.wildcard,
    },
  };
}

/** 日 / 周字段的命中判定（两者都限定时「满足任一」，见 `CronSpec`）。 */
function cronDayMatches(spec: CronSpec, at: Date): boolean {
  const day = spec.daysOfMonth.includes(at.getDate());
  const week = spec.daysOfWeek.includes(at.getDay());
  if (spec.domRestricted && spec.dowRestricted) {
    return day || week;
  }
  if (spec.domRestricted) {
    return day;
  }
  if (spec.dowRestricted) {
    return week;
  }
  return true;
}

/**
 * 这一分钟是否命中 cron（**分钟粒度**）。
 *
 * 调度器就用它判断「本轮该不该发」：进程停了几小时也不会补发 —— 只有当前这一分钟
 * 命中才算到点（ADR-0062 的「错过不补发」）。
 */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  return (
    spec.minutes.includes(at.getMinutes()) &&
    spec.hours.includes(at.getHours()) &&
    spec.months.includes(at.getMonth() + 1) &&
    cronDayMatches(spec, at)
  );
}

/**
 * 从 `from` 往后算 `count` 个执行时刻（本地时区，**严格晚于 `from` 所在的那一分钟**）。
 *
 * 逐日推进而不是逐分钟推进：像 `0 0 29 2 *`（闰年）这种要跨好几年，逐分钟会白跑几百万次，
 * 而像 `0 0 30 2 *`（2 月 30 日，永远不触发）必须能**快速**返回空数组而不是挂住。
 */
export function nextFireTimes(
  spec: CronSpec,
  from: Date,
  count: number,
): Date[] {
  const wanted = Math.max(0, Math.min(count, MAX_NEXT_TIMES));
  const result: Date[] = [];
  if (wanted === 0) {
    return result;
  }
  const cursor = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    0,
    0,
    0,
    0,
  );
  const threshold = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    from.getHours(),
    from.getMinutes(),
    0,
    0,
  ).getTime();
  for (let day = 0; day < NEXT_SCAN_MAX_DAYS; day += 1) {
    const at = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + day,
    );
    if (
      spec.months.includes(at.getMonth() + 1) &&
      cronDayMatches(spec, at)
    ) {
      for (const hour of spec.hours) {
        for (const minute of spec.minutes) {
          const candidate = new Date(
            at.getFullYear(),
            at.getMonth(),
            at.getDate(),
            hour,
            minute,
            0,
            0,
          );
          if (candidate.getTime() <= threshold) {
            continue;
          }
          result.push(candidate);
          if (result.length >= wanted) {
            return result;
          }
        }
      }
    }
  }
  return result;
}

/** 便捷版：给一段 cron 文本，直接要「后 N 次执行时间」（非法表达式返回空数组）。 */
export function nextTimesOfCron(
  expression: string,
  from: Date,
  count = ANNOUNCEMENT_NEXT_TIMES,
): Date[] {
  const parsed = parseCronExpression(expression);
  return parsed.ok ? nextFireTimes(parsed.spec, from, count) : [];
}

/** 本地时间 `YYYY-MM-DD HH:mm`（同时充当「触发时刻」的去重键）。 */
export function minuteKeyOf(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/* -------------------------------------------------------------------------- */
/* 任务模型                                                                    */
/* -------------------------------------------------------------------------- */

/** 群配置 KV 里存任务数组的键（`group_settings` 表，老库免迁移）。 */
export const ANNOUNCEMENT_SETTING_KEY = "scheduledAnnouncements";
/** 群配置 KV 里存「最近触发记录」的键（每小时上限 + 排查用）。 */
export const ANNOUNCEMENT_FIRES_KEY = "scheduledAnnouncementFires";

export const MAX_ANNOUNCEMENTS_PER_GROUP = 10;
export const MAX_ANNOUNCEMENT_BUTTONS = 5;
export const ANNOUNCEMENT_TEXT_MAX = 300;
export const ANNOUNCEMENT_TITLE_MAX = 30;
export const ANNOUNCEMENT_QUOTE_MAX = 200;
/** 「下次执行时间」默认算几条（用户 2026-10-03 要求：配置 / 查询时给后五次）。 */
export const ANNOUNCEMENT_NEXT_TIMES = 5;
/** 每群每小时最多触发几次（防手滑写 `* * * * *` 把群刷屏 / 打满主动消息额度）。 */
export const DEFAULT_ANNOUNCEMENT_HOURLY_LIMIT = 6;
/** 默认卡片标题（`mode=card` 且没写 title 时）。 */
export const DEFAULT_ANNOUNCEMENT_TITLE = "定时发言";

/**
 * 消息形态：
 * - `text`：走**纯文本通道**（官方 `<@!openid>` 提及只在这条通道里生效）；
 * - `card`：Markdown 卡片（引用块与按钮都只在这条通道里可用）。
 */
export type AnnouncementMode = "text" | "card";

export interface AnnouncementButton {
  /** 按钮文字（最长 10 字，卡片标准硬约束）。 */
  label: string;
  /** 点击后发送的指令（与手输同一条权限 / 审计路径）。 */
  command: string;
  /** 点击后的指令**带引用回复本消息**（官方 `action.reply`）。 */
  reply?: boolean | undefined;
}

export interface AnnouncementContent {
  mode: AnnouncementMode;
  title: string;
  /** 正文（纯文本模式直接发它；卡片模式作为 Markdown 正文）。 */
  text: string;
  /** 引用块原文（Markdown `>` 段落；只在卡片模式使用）。 */
  quote?: string | undefined;
  /** 自定义按钮（卡片模式）。 */
  buttons: readonly AnnouncementButton[];
  /**
   * 发送时**引用回复本群上一条机器人消息**（尽力而为）。
   *
   * 官方的引用回复需要目标消息的 `msg_id`，且只有 5 分钟被动窗口；定时发言手里通常没有。
   * 因此这里的口径是：5 分钟内有机器人刚发出去的消息就带引用，没有就**照常普通发送**
   * （正文里的引用块已经把原文展示出来了，观感不丢）。真机取证项见 TODO §4。
   */
  reference: boolean;
}

export interface ScheduledAnnouncement {
  id: string;
  groupId: string;
  /** 原始 cron 文本（5 段）；展示与解析都用它。 */
  cron: string;
  /** 默认**关闭**：新建任务一律 `false`，要显式开启才会发。 */
  enabled: boolean;
  content: AnnouncementContent;
  /** 上次触发时刻（`minuteKeyOf`）；重启后据此不重发同一分钟。 */
  lastFiredAt?: string | undefined;
  createdBy: string;
  createdAt: string;
  updatedBy?: string | undefined;
  updatedAt: string;
}

export interface AnnouncementFireRecord {
  taskId: string;
  /** ISO 时间戳。 */
  at: string;
}

/** 可局部更新的内容字段（指令层 / 后台都只传要改的那几个）。 */
export interface AnnouncementContentInput {
  mode?: AnnouncementMode | undefined;
  title?: string | undefined;
  text?: string | undefined;
  quote?: string | undefined;
  buttons?: readonly AnnouncementButton[] | undefined;
  reference?: boolean | undefined;
}

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

/** 按卡片标准把按钮打包成行：每行 ≤5 个、且一行文字总长 ≤12 字。 */
export function packButtonRows(
  buttons: readonly AnnouncementButton[],
): CardButton[][] {
  const rows: CardButton[][] = [];
  let current: CardButton[] = [];
  let width = 0;
  for (const [index, button] of buttons.entries()) {
    const label = button.label.trim();
    if (
      current.length >= CARD_MAX_BUTTONS_PER_ROW ||
      (current.length > 0 && width + label.length > CARD_MAX_ROW_TEXT_LENGTH)
    ) {
      rows.push(current);
      current = [];
      width = 0;
    }
    current.push({
      id: `announce-btn-${index + 1}`,
      label,
      command: button.command.trim(),
      ...(button.reply === true ? { reply: true } : {}),
    });
    width += label.length;
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows;
}

/**
 * 把一条定时发言渲染成要发出去的消息（**预览与真实发送共用这一份**，
 * 避免「预览好看、发出去是另一张卡」）。
 */
export function renderAnnouncementMessage(
  content: AnnouncementContent,
): RichMessage {
  if (content.mode === "text") {
    return { markdown: content.text, text: content.text };
  }
  const lines: string[] = [content.text];
  if (content.quote !== undefined) {
    lines.push("", ...quoteCardLines(content.quote));
  }
  return renderCard({
    title: content.title,
    lines,
    rows: packButtonRows(content.buttons),
  });
}

/** 指令层 / 后台回给操作者的预览卡：形态、cron 与**后五次执行时间**。 */
export function renderAnnouncementPreview(options: {
  announcement: ScheduledAnnouncement;
  groupLabel: string;
  globalEnabled: boolean;
  nextTimes: readonly Date[];
  /** 卡片标题；缺省「定时发言预览」。 */
  title?: string | undefined;
}): RichMessage {
  const { announcement, nextTimes } = options;
  const title = options.title ?? "定时发言预览";
  const lines: string[] = [
    `**范围**：${options.groupLabel}`,
    `**时间表**：\`${announcement.cron}\`（本地时区）`,
    `**形态**：${announcement.content.mode === "card" ? "卡片" : "纯文本"}${
      announcement.content.buttons.length > 0
        ? ` + ${announcement.content.buttons.length} 个按钮`
        : ""
    }`,
    `**状态**：${announcement.enabled ? "已启用" : "已停用"}`,
  ];
  if (announcement.content.quote !== undefined) {
    lines.push(`**引用块**：${announcement.content.quote.split("\n")[0] ?? ""}`);
  }
  if (announcement.content.buttons.length > 0) {
    lines.push(
      `**按钮**：${announcement.content.buttons
        .map((button) => `${button.label}（\`${button.command}\`${button.reply === true ? " 带引用" : ""}）`)
        .join("、")}`,
    );
  }
  if (announcement.content.reference) {
    lines.push("**引用回复**：尽力而为（5 分钟内本群有机器人消息才带得上）");
  }
  lines.push(
    "",
    nextTimes.length > 0
      ? "**后五次执行时间**："
      : "**后五次执行时间**：算不出来（表达式的日期组合不存在，比如 2 月 30 日）",
  );
  for (const time of nextTimes) {
    lines.push(`· ${minuteKeyOf(time)}`);
  }
  if (!options.globalEnabled) {
    lines.push("", "⚠️ 定时发言的**总开关**关着，这条任务不会触发。");
  }
  lines.push("", "**即将发出的内容**：", announcement.content.text);
  if (announcement.content.quote !== undefined) {
    lines.push(...quoteCardLines(announcement.content.quote));
  }
  return {
    markdown: `## ${title}\n${lines.join("\n")}`,
    text: `【${title}】\n${lines.join("\n")}`,
  };
}

/* -------------------------------------------------------------------------- */
/* 校验                                                                        */
/* -------------------------------------------------------------------------- */

export type ContentNormalizeResult =
  | { ok: true; content: AnnouncementContent }
  | { ok: false; error: string };

function normalizeButtons(
  buttons: readonly AnnouncementButton[],
): ContentNormalizeResult | undefined {
  if (buttons.length > MAX_ANNOUNCEMENT_BUTTONS) {
    return {
      ok: false,
      error: `按钮最多 ${MAX_ANNOUNCEMENT_BUTTONS} 个（收到 ${buttons.length} 个）`,
    };
  }
  const normalized: AnnouncementButton[] = [];
  for (const button of buttons) {
    const label = button.label.trim();
    if (label.length === 0) {
      return { ok: false, error: "按钮文字不能为空" };
    }
    if (label.length > 10) {
      return { ok: false, error: `按钮文字最多 10 个字（收到：${label}）` };
    }
    const command = button.command.trim();
    if (command.length === 0) {
      return { ok: false, error: `按钮「${label}」没有指令` };
    }
    normalized.push({
      label,
      command,
      ...(button.reply === true ? { reply: true } : {}),
    });
  }
  return undefined;
}

/** 归一化 + 校验一条定时发言的内容（写入前唯一入口）。 */
export function normalizeAnnouncementContent(
  input: AnnouncementContentInput,
): ContentNormalizeResult {
  const mode: AnnouncementMode = input.mode ?? "text";
  if (mode !== "text" && mode !== "card") {
    return { ok: false, error: `形态只能是 text 或 card（收到：${String(input.mode)}）` };
  }
  const text = (input.text ?? "").trim();
  if (text.length === 0) {
    return { ok: false, error: "正文不能为空" };
  }
  if (text.length > ANNOUNCEMENT_TEXT_MAX) {
    return {
      ok: false,
      error: `正文最多 ${ANNOUNCEMENT_TEXT_MAX} 个字（收到 ${text.length} 个）`,
    };
  }
  const title = (input.title ?? "").trim() || DEFAULT_ANNOUNCEMENT_TITLE;
  if (title.length > ANNOUNCEMENT_TITLE_MAX) {
    return {
      ok: false,
      error: `卡片标题最多 ${ANNOUNCEMENT_TITLE_MAX} 个字（收到 ${title.length} 个）`,
    };
  }
  const quoteText = (input.quote ?? "").trim();
  if (quoteText.length > ANNOUNCEMENT_QUOTE_MAX) {
    return {
      ok: false,
      error: `引用块最多 ${ANNOUNCEMENT_QUOTE_MAX} 个字（收到 ${quoteText.length} 个）`,
    };
  }
  const buttons = input.buttons ?? [];
  const buttonError = normalizeButtons(buttons);
  if (buttonError) {
    return buttonError;
  }
  const reference = input.reference === true;
  if (mode === "text" && (quoteText.length > 0 || buttons.length > 0 || reference)) {
    return {
      ok: false,
      error: "引用块 / 按钮 / 引用回复只能用在卡片形态（把形态改成 card）",
    };
  }
  return {
    ok: true,
    content: {
      mode,
      title,
      text,
      ...(quoteText.length > 0 ? { quote: quoteText } : {}),
      buttons: buttons.map((button) => ({
        label: button.label.trim(),
        command: button.command.trim(),
        ...(button.reply === true ? { reply: true } : {}),
      })),
      reference,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 存储（群配置 KV）                                                           */
/* -------------------------------------------------------------------------- */

function parseAnnouncements(
  raw: string,
  groupId: string,
): ScheduledAnnouncement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("invalid scheduled announcements json, treating as empty", {
      groupId,
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const result: ScheduledAnnouncement[] = [];
  for (const item of parsed) {
    const task = parseAnnouncement(item, groupId);
    if (task) {
      result.push(task);
    }
  }
  return result;
}

function parseAnnouncement(
  item: unknown,
  groupId: string,
): ScheduledAnnouncement | undefined {
  if (typeof item !== "object" || item === null) {
    return undefined;
  }
  const raw = item as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.cron !== "string") {
    return undefined;
  }
  const content = parseContent(raw.content);
  if (!content) {
    return undefined;
  }
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString();
  const createdBy = typeof raw.createdBy === "string" ? raw.createdBy : "";
  return {
    id: raw.id,
    groupId,
    cron: raw.cron,
    enabled: raw.enabled === true,
    content,
    ...(typeof raw.lastFiredAt === "string" ? { lastFiredAt: raw.lastFiredAt } : {}),
    createdBy,
    createdAt,
    ...(typeof raw.updatedBy === "string" ? { updatedBy: raw.updatedBy } : {}),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
  };
}

function parseContent(value: unknown): AnnouncementContent | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== "string") {
    return undefined;
  }
  const mode: AnnouncementMode = raw.mode === "card" ? "card" : "text";
  const buttons: AnnouncementButton[] = [];
  if (Array.isArray(raw.buttons)) {
    for (const item of raw.buttons) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const button = item as Record<string, unknown>;
      if (typeof button.label !== "string" || typeof button.command !== "string") {
        continue;
      }
      buttons.push({
        label: button.label,
        command: button.command,
        ...(button.reply === true ? { reply: true } : {}),
      });
    }
  }
  return {
    mode,
    title:
      typeof raw.title === "string" && raw.title.trim().length > 0
        ? raw.title
        : DEFAULT_ANNOUNCEMENT_TITLE,
    text: raw.text,
    ...(typeof raw.quote === "string" && raw.quote.length > 0
      ? { quote: raw.quote }
      : {}),
    buttons,
    reference: raw.reference === true,
  };
}

function parseFires(raw: string): AnnouncementFireRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is AnnouncementFireRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).taskId === "string" &&
        typeof (item as Record<string, unknown>).at === "string",
    );
  } catch {
    return [];
  }
}

function sortAnnouncements(
  list: readonly ScheduledAnnouncement[],
): ScheduledAnnouncement[] {
  return [...list].sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id);
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

/**
 * 定时发言的存储（`group_settings` 的「每群一个 JSON 数组」）。
 *
 * 与 `NotifyTopicLevelStore` 同一套做法：内存为准 + `WriteQueue` 写穿透，
 * 老库不用迁移（键值表天然幂等）。
 */
export class ScheduledAnnouncementStore {
  private readonly byGroup = new Map<string, ScheduledAnnouncement[]>();
  private readonly fires = new Map<string, AnnouncementFireRecord[]>();

  public constructor(
    private readonly repository?: GroupSettingsRepository | undefined,
    private readonly queue?: WriteQueue | undefined,
  ) {}

  public async load(): Promise<void> {
    this.byGroup.clear();
    this.fires.clear();
    const rows = (await this.repository?.findAll()) ?? [];
    for (const row of rows) {
      if (row.key === ANNOUNCEMENT_SETTING_KEY) {
        const bucket = this.byGroup.get(row.groupId) ?? [];
        bucket.push(...parseAnnouncements(row.value, row.groupId));
        this.byGroup.set(row.groupId, sortAnnouncements(bucket));
      } else if (row.key === ANNOUNCEMENT_FIRES_KEY) {
        this.fires.set(row.groupId, parseFires(row.value));
      }
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public list(groupId: string): ScheduledAnnouncement[] {
    return sortAnnouncements(this.byGroup.get(groupId) ?? []);
  }

  public all(): ScheduledAnnouncement[] {
    return sortAnnouncements([...this.byGroup.values()].flat());
  }

  public find(id: string): ScheduledAnnouncement | undefined {
    for (const bucket of this.byGroup.values()) {
      const found = bucket.find((task) => task.id === id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** 新增或整体替换一条任务（按 id 覆盖），并落库。 */
  public put(task: ScheduledAnnouncement): void {
    const bucket = this.byGroup.get(task.groupId) ?? [];
    const index = bucket.findIndex((item) => item.id === task.id);
    if (index >= 0) {
      bucket[index] = task;
    } else {
      bucket.push(task);
    }
    this.byGroup.set(task.groupId, sortAnnouncements(bucket));
    this.persist(task.groupId);
  }

  /** 记下「这个任务在这一分钟已经触发过」，用于重启后不重发。 */
  public markFired(id: string, minuteKey: string): void {
    const task = this.find(id);
    if (!task) {
      return;
    }
    this.put({ ...task, lastFiredAt: minuteKey });
  }

  public remove(id: string): ScheduledAnnouncement | undefined {
    for (const [groupId, bucket] of this.byGroup) {
      const index = bucket.findIndex((task) => task.id === id);
      if (index < 0) {
        continue;
      }
      const [removed] = bucket.splice(index, 1);
      this.byGroup.set(groupId, bucket);
      this.persist(groupId);
      return removed;
    }
    return undefined;
  }

  /** 记一条触发记录（每小时上限的判据 + 排查用）。 */
  public recordFire(groupId: string, taskId: string, at: Date): void {
    const bucket = this.fires.get(groupId) ?? [];
    bucket.push({ taskId, at: at.toISOString() });
    const cutoff = at.getTime() - 24 * 60 * 60 * 1_000;
    const kept = bucket
      .filter((fire) => Date.parse(fire.at) >= cutoff)
      .slice(-200);
    this.fires.set(groupId, kept);
    if (!this.repository) {
      return;
    }
    this.queue?.enqueue("announce.fires.save", () =>
      this.repository!.save({
        groupId,
        key: ANNOUNCEMENT_FIRES_KEY,
        value: JSON.stringify(kept),
      }),
    );
  }

  public firesSince(groupId: string, since: Date): AnnouncementFireRecord[] {
    return (this.fires.get(groupId) ?? []).filter(
      (fire) => Date.parse(fire.at) >= since.getTime(),
    );
  }

  private persist(groupId: string): void {
    const repository = this.repository;
    if (!repository) {
      return;
    }
    const tasks = this.byGroup.get(groupId) ?? [];
    if (tasks.length === 0) {
      this.byGroup.delete(groupId);
      this.queue?.enqueue("announce.save", () =>
        repository.remove(groupId, ANNOUNCEMENT_SETTING_KEY),
      );
      return;
    }
    const value = JSON.stringify(tasks);
    this.queue?.enqueue("announce.save", () =>
      repository.save({ groupId, key: ANNOUNCEMENT_SETTING_KEY, value }),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 服务                                                                        */
/* -------------------------------------------------------------------------- */

/** 发送通道（`RichMessageSender` 结构上就满足它，测试里可以给假实现）。 */
export interface AnnouncementSender {
  sendToGroup(groupId: string, message: RichMessage): Promise<RichSendResult>;
  replyToGroup(
    groupId: string,
    message: RichMessage,
    options: { msgId: string },
  ): Promise<RichSendResult>;
  sendPlainToGroup(groupId: string, content: string): Promise<RichSendResult>;
  sendToUser(userOpenid: string, message: RichMessage): Promise<RichSendResult>;
}

export interface AnnouncementRunSummary {
  fired: number;
  sent: number;
  failed: number;
  /** 按钮被平台拒 / 被降级掉的消息条数。 */
  degraded: number;
  skippedDisabled: number;
  skippedNotDue: number;
  skippedDuplicate: number;
  skippedRateLimited: number;
  skippedInvalid: number;
}

export type AnnouncementMutationResult =
  | { ok: true; announcement: ScheduledAnnouncement }
  | { ok: false; error: string };

/** 启停结果：本来就是这个状态时如实回 `changed: false`（不写审计）。 */
export type AnnouncementToggleResult =
  | { ok: true; announcement: ScheduledAnnouncement; changed: boolean }
  | { ok: false; error: string };

export interface ScheduledAnnouncementServiceOptions {
  store: ScheduledAnnouncementStore;
  sender?: AnnouncementSender | undefined;
  audit?: AuditLog | undefined;
  now?: (() => Date) | undefined;
  /** 每群每小时触发上限（热配置；`0` = 不限制）。 */
  hourlyLimit?: (() => number) | undefined;
  /** 群展示名（失败私信里给「哪个群」，不把内部长 id 甩给人看）。 */
  groupLabel?: ((groupId: string) => string) | undefined;
}

/**
 * 机器人定时发言（默认关闭；**每群群管 130 各自配本群**）。
 *
 * 这一层不做权限判断：指令层与后台写端点各自按「本群 130」判完再调这里，
 * 保证两条入口走的是同一份校验、同一份落库、同一份发送（ADR-0058）。
 *
 * 幂等口径（ADR-0062）：去重键是「任务 + 触发的那一分钟」，
 * 因此**重启不重发**、**错过的时间点不补发**（进程停了几小时也只是错过，不倒回来发）。
 */
export class ScheduledAnnouncementService {
  private readonly store: ScheduledAnnouncementStore;
  private readonly sender: AnnouncementSender | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly now: () => Date;
  private readonly hourlyLimitOf: () => number;
  private readonly groupLabel: (groupId: string) => string;
  /** 本群最近一次机器人消息（5 分钟被动窗口内才可用于「引用回复」）。 */
  private readonly lastMessages = new Map<string, { id: string; at: number }>();

  public constructor(options: ScheduledAnnouncementServiceOptions) {
    this.store = options.store;
    this.sender = options.sender;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
    this.hourlyLimitOf =
      options.hourlyLimit ?? (() => DEFAULT_ANNOUNCEMENT_HOURLY_LIMIT);
    this.groupLabel = options.groupLabel ?? ((groupId) => groupId);
  }

  public list(groupId: string): ScheduledAnnouncement[] {
    return this.store.list(groupId);
  }

  public all(): ScheduledAnnouncement[] {
    return this.store.all();
  }

  public find(id: string): ScheduledAnnouncement | undefined {
    return this.store.find(id);
  }

  /** 后 N 次执行时间（配置 / 查询都靠它，前端与卡片共用）。 */
  public nextTimes(
    cron: string,
    count = ANNOUNCEMENT_NEXT_TIMES,
    from = this.now(),
  ): Date[] {
    return nextTimesOfCron(cron, from, count);
  }

  public preview(
    announcement: ScheduledAnnouncement,
    options: {
      groupLabel: string;
      globalEnabled: boolean;
      count?: number;
      title?: string | undefined;
    },
  ): RichMessage {
    return renderAnnouncementPreview({
      announcement,
      groupLabel: options.groupLabel,
      globalEnabled: options.globalEnabled,
      nextTimes: this.nextTimes(
        announcement.cron,
        options.count ?? ANNOUNCEMENT_NEXT_TIMES,
      ),
      ...(options.title !== undefined ? { title: options.title } : {}),
    });
  }

  /** 新建任务：**默认停用**，必须显式开启（用户口径：默认关闭）。 */
  public create(input: {
    groupId: string;
    cron: string;
    content: AnnouncementContentInput;
    actorId: string;
  }): AnnouncementMutationResult {
    const groupId = input.groupId.trim();
    if (groupId.length === 0) {
      return { ok: false, error: "没有指定群" };
    }
    const parsed = parseCronExpression(input.cron);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const content = normalizeAnnouncementContent(input.content);
    if (!content.ok) {
      return { ok: false, error: content.error };
    }
    const existing = this.store.list(groupId);
    if (existing.length >= MAX_ANNOUNCEMENTS_PER_GROUP) {
      return {
        ok: false,
        error: `每个群最多 ${MAX_ANNOUNCEMENTS_PER_GROUP} 条定时发言（先删掉不用的）`,
      };
    }
    const at = this.now().toISOString();
    const announcement: ScheduledAnnouncement = {
      id: randomUUID(),
      groupId,
      cron: input.cron.trim(),
      enabled: false,
      content: content.content,
      createdBy: input.actorId,
      createdAt: at,
      updatedAt: at,
    };
    this.store.put(announcement);
    this.appendAudit(
      input.actorId,
      groupId,
      "announce_create",
      AuditStatus.Executed,
      `新建定时发言：${announcement.cron}（默认停用）`,
    );
    return { ok: true, announcement };
  }

  /** 改一条任务：cron / 内容 / 启停都能分开改，改动写审计。 */
  public update(
    id: string,
    patch: {
      cron?: string | undefined;
      enabled?: boolean | undefined;
      content?: AnnouncementContentInput | undefined;
    },
    actorId: string,
  ): AnnouncementMutationResult {
    const current = this.store.find(id);
    if (!current) {
      return { ok: false, error: "定时发言不存在（可能刚被删掉）" };
    }
    let cron = current.cron;
    if (patch.cron !== undefined) {
      const parsed = parseCronExpression(patch.cron);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }
      cron = patch.cron.trim();
    }
    let content = current.content;
    if (patch.content !== undefined) {
      const merged = normalizeAnnouncementContent({
        mode: patch.content.mode ?? current.content.mode,
        title: patch.content.title ?? current.content.title,
        text: patch.content.text ?? current.content.text,
        quote: patch.content.quote ?? current.content.quote ?? "",
        buttons: patch.content.buttons ?? current.content.buttons,
        reference: patch.content.reference ?? current.content.reference,
      });
      if (!merged.ok) {
        return { ok: false, error: merged.error };
      }
      content = merged.content;
    }
    const updated: ScheduledAnnouncement = {
      ...current,
      cron,
      enabled: patch.enabled ?? current.enabled,
      content,
      updatedBy: actorId,
      updatedAt: this.now().toISOString(),
    };
    this.store.put(updated);
    this.appendAudit(
      actorId,
      current.groupId,
      "announce_update",
      AuditStatus.Executed,
      describeUpdate(current, updated),
    );
    return { ok: true, announcement: updated };
  }

  public remove(id: string, actorId: string): AnnouncementMutationResult {
    const removed = this.store.remove(id);
    if (!removed) {
      return { ok: false, error: "定时发言不存在（可能刚被删掉）" };
    }
    this.appendAudit(
      actorId,
      removed.groupId,
      "announce_remove",
      AuditStatus.Executed,
      `删除定时发言：${removed.cron}（${summaryOf(removed.content)}）`,
    );
    return { ok: true, announcement: removed };
  }

  public setEnabled(
    id: string,
    enabled: boolean,
    actorId: string,
  ): AnnouncementToggleResult {
    const current = this.store.find(id);
    if (!current) {
      return { ok: false, error: "定时发言不存在（可能刚被删掉）" };
    }
    if (current.enabled === enabled) {
      return { ok: true, announcement: current, changed: false };
    }
    const updated = this.update(id, { enabled }, actorId);
    if (!updated.ok) {
      return { ok: false, error: updated.error };
    }
    return { ok: true, announcement: updated.announcement, changed: true };
  }

  /** 「立即发送」：手工触发一次（同样计入每小时上限，防止拿来刷频）。 */
  public async sendNow(
    id: string,
    actorId: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const task = this.store.find(id);
    if (!task) {
      return { ok: false, detail: "定时发言不存在（可能刚被删掉）" };
    }
    const now = this.now();
    const limited = this.rateLimitOf(task.groupId, now);
    if (limited !== undefined) {
      return { ok: false, detail: limited };
    }
    const summary = emptySummary();
    await this.fire(task, "manual", now, summary);
    return {
      ok: summary.failed === 0,
      detail:
        summary.failed === 0
          ? "已发送"
          : "没有发出去（原因见私信与日志）",
    };
  }

  /**
   * 扫一轮：到点、启用、且这一分钟还没发过的任务 → 发出去。
   *
   * 精度 = `SCAN_INTERVAL_MS`（定时发言只能精确到分钟）；进程停过就跳过那些时间点，
   * **不补发**（用户口径）。
   */
  public async runOnce(now = this.now()): Promise<AnnouncementRunSummary> {
    const summary = emptySummary();
    const minuteKey = minuteKeyOf(now);
    for (const task of this.store.all()) {
      if (!task.enabled) {
        summary.skippedDisabled += 1;
        continue;
      }
      const parsed = parseCronExpression(task.cron);
      if (!parsed.ok) {
        summary.skippedInvalid += 1;
        log.warn("scheduled announcement has invalid cron", {
          taskId: task.id,
          groupId: task.groupId,
          error: parsed.error,
        });
        continue;
      }
      if (!cronMatches(parsed.spec, now)) {
        summary.skippedNotDue += 1;
        continue;
      }
      if (task.lastFiredAt === minuteKey) {
        summary.skippedDuplicate += 1;
        continue;
      }
      const limited = this.rateLimitOf(task.groupId, now);
      if (limited !== undefined) {
        summary.skippedRateLimited += 1;
        log.warn("scheduled announcement skipped: hourly limit", {
          taskId: task.id,
          groupId: task.groupId,
          limit: this.hourlyLimitOf(),
        });
        // 同一分钟不再反复尝试；这一分钟算「已处理」，但**不写触发记录**（它没发）
        this.store.markFired(task.id, minuteKey);
        await this.notifyFailure(task, limited);
        continue;
      }
      summary.fired += 1;
      await this.fire(task, "cron", now, summary);
    }
    return summary;
  }

  private rateLimitOf(groupId: string, at: Date): string | undefined {
    const limit = this.hourlyLimitOf();
    if (limit <= 0) {
      return undefined;
    }
    const used = this.store.firesSince(
      groupId,
      new Date(at.getTime() - 60 * 60 * 1_000),
    ).length;
    if (used < limit) {
      return undefined;
    }
    return `本群这一小时已经发了 ${used} 条定时发言（上限 ${limit} 条），这次不发。`;
  }

  private async fire(
    task: ScheduledAnnouncement,
    trigger: "cron" | "manual",
    at: Date,
    summary: AnnouncementRunSummary,
  ): Promise<void> {
    const outcome = await this.deliver(task);
    // 先记「这一分钟处理过了」：失败也不重试（下一轮不是同一个触发时刻）
    this.store.markFired(task.id, minuteKeyOf(at));
    this.store.recordFire(task.groupId, task.id, at);
    const actorId = task.updatedBy ?? task.createdBy;
    if (outcome.ok) {
      summary.sent += 1;
      if (task.content.buttons.length > 0 && outcome.mode !== "markdown+keyboard") {
        summary.degraded += 1;
      }
      this.appendAudit(
        actorId,
        task.groupId,
        "announce_fire",
        AuditStatus.Executed,
        `${trigger === "cron" ? "到点发送" : "手动发送"}：${outcome.mode}${
          outcome.detail.length > 0 ? `（${outcome.detail}）` : ""
        }`,
      );
      log.info("scheduled announcement sent", {
        taskId: task.id,
        groupId: task.groupId,
        mode: outcome.mode,
        detail: outcome.detail,
      });
      return;
    }
    summary.failed += 1;
    this.appendAudit(
      actorId,
      task.groupId,
      "announce_fire",
      AuditStatus.Rejected,
      `${trigger === "cron" ? "到点发送" : "手动发送"}失败：${outcome.detail}`,
    );
    log.warn("scheduled announcement failed", {
      taskId: task.id,
      groupId: task.groupId,
      detail: outcome.detail,
    });
    // 只私信配置者（群里不留失败痕迹，免得像机器人抽风）
    await this.notifyFailure(
      task,
      `定时发言发送失败：${outcome.detail}`,
    );
  }

  private async deliver(task: ScheduledAnnouncement): Promise<RichSendResult> {
    const sender = this.sender;
    if (!sender) {
      return { ok: false, detail: "发送通道未装配", mode: "none" };
    }
    if (task.content.mode === "text") {
      return sender.sendPlainToGroup(task.groupId, task.content.text);
    }
    const message = renderAnnouncementMessage(task.content);
    const msgId = task.content.reference
      ? this.recentMessageId(task.groupId)
      : undefined;
    const result =
      msgId !== undefined
        ? await sender.replyToGroup(task.groupId, message, { msgId })
        : await sender.sendToGroup(task.groupId, message);
    if (result.ok && result.messageId !== undefined) {
      this.lastMessages.set(task.groupId, {
        id: result.messageId,
        at: this.now().getTime(),
      });
    }
    return result;
  }

  private recentMessageId(groupId: string): string | undefined {
    const entry = this.lastMessages.get(groupId);
    if (!entry) {
      return undefined;
    }
    if (this.now().getTime() - entry.at >= DEFAULT_PASSIVE_REPLY_WINDOW_MS) {
      this.lastMessages.delete(groupId);
      return undefined;
    }
    return entry.id;
  }

  /** 发送失败时只私信群管（配置者 / 最后改的人），不在群里刷失败提示。 */
  private async notifyFailure(
    task: ScheduledAnnouncement,
    detail: string,
  ): Promise<void> {
    const sender = this.sender;
    if (!sender) {
      return;
    }
    const recipients = [...new Set([task.updatedBy ?? task.createdBy])].filter(
      (openid) => openid.length > 0,
    );
    for (const openid of recipients) {
      try {
        await sender.sendToUser(openid, {
          markdown: `## 定时发言没有发出去\n\n**群**：${this.groupLabel(task.groupId)}\n**时间表**：\`${task.cron}\`\n**原因**：${detail}`,
          text: `定时发言没有发出去：${detail}`,
        });
      } catch (error) {
        log.warn("failed to notify announcement owner", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private appendAudit(
    actorId: string,
    groupId: string,
    action: string,
    status: AuditStatus,
    reason: string,
  ): void {
    this.audit?.append({
      recordId: randomUUID(),
      groupId,
      actorId,
      action,
      status,
      reason,
      createdAt: this.now(),
    });
  }
}

function emptySummary(): AnnouncementRunSummary {
  return {
    fired: 0,
    sent: 0,
    failed: 0,
    degraded: 0,
    skippedDisabled: 0,
    skippedNotDue: 0,
    skippedDuplicate: 0,
    skippedRateLimited: 0,
    skippedInvalid: 0,
  };
}

function summaryOf(content: AnnouncementContent): string {
  const shape = content.mode === "card" ? "卡片" : "纯文本";
  const buttons =
    content.buttons.length > 0 ? `、${content.buttons.length} 个按钮` : "";
  const quote = content.quote !== undefined ? "、引用块" : "";
  const reference = content.reference ? "、引用回复" : "";
  return `${shape}${quote}${buttons}${reference}`;
}

function describeUpdate(
  before: ScheduledAnnouncement,
  after: ScheduledAnnouncement,
): string {
  const changes: string[] = [];
  if (before.cron !== after.cron) {
    changes.push(`时间表 ${before.cron} → ${after.cron}`);
  }
  if (before.enabled !== after.enabled) {
    changes.push(after.enabled ? "启用" : "停用");
  }
  if (before.content.text !== after.content.text) {
    changes.push("正文");
  }
  if (before.content.mode !== after.content.mode) {
    changes.push(`形态 ${before.content.mode} → ${after.content.mode}`);
  }
  if (before.content.title !== after.content.title) {
    changes.push(`标题 → ${after.content.title}`);
  }
  if (before.content.quote !== after.content.quote) {
    changes.push("引用块");
  }
  if (before.content.buttons.length !== after.content.buttons.length) {
    changes.push(`按钮 ${before.content.buttons.length} → ${after.content.buttons.length}`);
  }
  if (before.content.reference !== after.content.reference) {
    changes.push(after.content.reference ? "开引用回复" : "关引用回复");
  }
  return changes.length > 0 ? `修改：${changes.join("、")}` : "修改：无变化";
}
