import { DEFAULT_ACTIVITY_STATS_FONT_URL } from "../config.js";
import { compareLabels } from "../core/collation.js";
import { getLogger } from "../core/logger.js";
import type {
  Activity,
  ActivityRegistration,
} from "./activity.js";
import { formatCloseAt } from "./activityCards.js";
import type { UserProfile } from "./userProfiles.js";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * activityStats 的类型、常量与纯函数（从 activityStats.ts 拆出；主文件会原样再导出公开名字）。
 */


export const log = getLogger("activity-stats");

/** 画布宽度（用户确认的固定宽度）。 */
export const STATS_IMAGE_WIDTH = 720;
/** 画布左右内边距。 */
export const STATS_PADDING = 40;
/**
 * 统计图片字体缓存目录。
 *
 * `.gitignore` 里 `data/` 整目录被忽略，因此字体**不随包提交**（用户确认的字体策略）。
 */
export const STATS_FONT_CACHE_DIR = join("data", "fonts");
/** 缓存文件名（不含版本号，避免隐私守卫把长数字当成可疑标识）。 */
export const STATS_FONT_CACHE_FILE = "activity-stats.otf";
/** 字体下载超时（毫秒）；超时即降级，不拖住事件处理链。 */
export const STATS_FONT_DOWNLOAD_TIMEOUT_MS = 10_000;

export { DEFAULT_ACTIVITY_STATS_FONT_URL };

/**
 * 常见系统中文字体路径（**系统优先**，用户确认的策略）。
 *
 * Windows：微软雅黑 / 等线；Linux：Noto CJK / 文泉驿；macOS：苹方 / 冬青黑。
 * 找不到系统字体才下载（见 `DEFAULT_ACTIVITY_STATS_FONT_URL`）。
 */
export const SYSTEM_FONT_PATHS: readonly string[] = [
  // Windows
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/msyh.ttf",
  "C:/Windows/Fonts/msyhbd.ttc",
  "C:/Windows/Fonts/simhei.ttf",
  "C:/Windows/Fonts/simsun.ttc",
  "C:/Windows/Fonts/Deng.ttf",
  // Linux（Debian/Ubuntu 常见路径）
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc",
  // macOS
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
];

export const COLORS = {
  background: "#FFFFFF",
  title: "#1F2329",
  subtitle: "#646A73",
  label: "#1F2329",
  muted: "#8F959E",
  divider: "#DEE0E3",
  barTrack: "#F0F2F5",
  barCollege: "#3370FF",
  barYear: "#00B42A",
} as const;

export const FONT_FAMILY = "ActivityStatsSans";

/** 统计图里的一次渲染请求（便于测试与复用）。 */
export interface ActivityStatsRenderInput {
  activity: Activity;
  registrations: readonly ActivityRegistration[];
  profiles?: ReadonlyMap<string, UserProfile> | undefined;
  /** 候补人数（管理卡同款统计要展示）。 */
  waitlistCount?: number | undefined;
  now?: Date | undefined;
}

export interface ActivityStatsServiceOptions {
  /** 群图片上传/发送所需的官方 API；未提供时无法发送（仍可渲染）。 */
  api?: StatsImageApi | undefined;
  /** 注入 fetch 实现（测试或特殊网络环境）。 */
  fetchImpl?: typeof fetch | undefined;
  /** 自定义系统字体探测（测试注入）。 */
  hasSystemFont?: ((path: string) => boolean) | undefined;
  /** 自定义字体文件读取（测试注入）。 */
  readFontFile?: ((path: string) => Uint8Array | undefined) | undefined;
  /** 字体缓存目录；默认 `data/fonts`。 */
  fontCacheDir?: string | undefined;
  /** 字体下载地址；默认 `DEFAULT_ACTIVITY_STATS_FONT_URL`。 */
  fontUrl?: string | undefined;
  /** 注入 canvas 模块加载器（缺省 `import("@napi-rs/canvas")`）。 */
  canvasLoader?: (() => Promise<CanvasModule>) | undefined;
  /** 注入渲染函数（排版固定，测试可断言绘制内容）。 */
  renderFn?: ((input: ActivityStatsRenderInput) => Promise<Buffer>) | undefined;
  /** 注入时钟。 */
  now?: (() => Date) | undefined;
}

/** 上传 + 发送群图片所需的最小 API 面。 */
export interface StatsImageApi {
  uploadGroupImage(
    groupId: string,
    fileName: string,
    data: Uint8Array,
  ): Promise<Record<string, unknown>>;
  sendGroupImage(
    groupId: string,
    fileInfo: string,
    msgId?: string,
  ): Promise<Record<string, unknown>>;
}

/** 渲染所需的最小 canvas 模块面（`@napi-rs/canvas` 的结构子集）。 */
export interface CanvasModule {
  createCanvas(width: number, height: number): PixelCanvas;
  GlobalFonts: {
    registerFromPath(path: string): unknown;
  };
}

/** 测试可注入的最小画布接口。 */
export interface PixelCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): PixelContext;
  toBuffer(mime: "image/png"): Buffer;
}

export interface PixelContext {
  fillStyle: string;
  font: string;
  textBaseline: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** 字体来源：系统路径 / 缓存文件 / 下载后缓存。 */
export interface ResolvedStatsFont {
  path: string;
  source: "system" | "cache" | "download";
}

/**
 * 活动统计图片（§B3）。
 *
 * 设计约束（用户确认）：
 * - **字体系统优先**：先探测 `SYSTEM_FONT_PATHS`（Windows 雅黑 / Linux Noto CJK / macOS 苹方），
 *   找不到才从 `ACTIVITY_STATS_FONT_URL` 下载并缓存到 `data/fonts/`（gitignored，不随包提交）；
 * - **依赖与字体都拿不到就返回 `undefined`**：调用方降级为文字统计卡，
 *   **绝不让启动或事件处理因为缺依赖而失败**（`@napi-rs/canvas` 是可选依赖，动态 import）；
 * - 发送是**可选能力**：`sendImageToGroup` 只在注入了官方 API 时存在，
 *   调用方据此决定是否渲染「统计图片」入口。
 *
 * 样式固定一套：宽度 720、高度按内容自适应；标题 + 四个数字 + 学院/年级横向条形。
 */
export interface DistributionEntry {
  label: string;
  count: number;
}

export interface StatsLayout {
  width: number;
  height: number;
  title: string;
  subtitle: string;
  facts: string[];
  colleges: DistributionEntry[];
  years: DistributionEntry[];
}

/**
 * 计算统计图的排版模型（宽 720，高按内容自适应）。
 *
 * 纯函数：不依赖 canvas，测试可以直接断言「学院/年级分布聚合与计数」。
 */
export function buildStatsLayout(input: ActivityStatsRenderInput): StatsLayout {
  const { activity, registrations } = input;
  const profiles = input.profiles;
  const waitlistCount = input.waitlistCount ?? 0;
  const now = input.now ?? new Date();
  const capacity = activity.capacity;
  const count = registrations.length;

  const colleges: string[] = [];
  const years: string[] = [];
  for (const registration of registrations) {
    const profile = profiles?.get(registration.userId);
    colleges.push(profile?.college ?? "");
    years.push(profile?.year ?? "");
  }

  const facts = [
    capacity === undefined ? `报名 ${count} 人（不限名额）` : `报名 ${count} / ${capacity}`,
    `候补 ${waitlistCount}`,
    `待释放名额 ${activity.heldSlots}`,
    `截止 ${formatCloseAt(activity, now)}`,
  ];

  const collegeEntries = distributionOf(colleges);
  const yearEntries = distributionOf(years);
  const height =
    STATS_PADDING * 2 +
    TITLE_HEIGHT +
    SUBTITLE_HEIGHT +
    facts.length * FACT_LINE_HEIGHT +
    SECTION_GAP * 2 +
    (collegeEntries.length + yearEntries.length) * (BAR_ROW_HEIGHT + BAR_ROW_GAP) +
    SECTION_HEADER_HEIGHT * 2;

  return {
    width: STATS_IMAGE_WIDTH,
    height: Math.max(height, 200),
    title: "活动统计",
    subtitle: `${activity.code} · ${activity.title}`,
    facts,
    colleges: collegeEntries,
    years: yearEntries,
  };
}

/** 按人数降序聚合（同人数按名称排序），保证渲染稳定；空值统一显示「（未填）」。 */
export function distributionOf(values: readonly string[]): DistributionEntry[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = normalizeLabel(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort(
      (left, right) =>
        right.count - left.count || compareLabels(left.label, right.label),
    );
}

export const TITLE_HEIGHT = 44;
export const SUBTITLE_HEIGHT = 32;
export const FACT_LINE_HEIGHT = 30;
export const SECTION_GAP = 20;
export const SECTION_HEADER_HEIGHT = 36;
export const BAR_ROW_HEIGHT = 26;
export const BAR_ROW_GAP = 10;

/** 用真实的 `@napi-rs/canvas` 画布渲染统计图。 */
export async function renderStatsImage(
  canvasModule: CanvasModule,
  input: ActivityStatsRenderInput,
): Promise<Buffer> {
  const layout = buildStatsLayout(input);
  const canvas = canvasModule.createCanvas(layout.width, layout.height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = "top";

  let y = STATS_PADDING;
  ctx.fillStyle = COLORS.title;
  ctx.font = `bold 32px ${FONT_FAMILY}`;
  ctx.fillText(layout.title, STATS_PADDING, y);
  y += TITLE_HEIGHT;

  ctx.fillStyle = COLORS.subtitle;
  ctx.font = `20px ${FONT_FAMILY}`;
  ctx.fillText(layout.subtitle, STATS_PADDING, y);
  y += SUBTITLE_HEIGHT;

  ctx.fillStyle = COLORS.label;
  ctx.font = `22px ${FONT_FAMILY}`;
  for (const fact of layout.facts) {
    ctx.fillText(fact, STATS_PADDING, y);
    y += FACT_LINE_HEIGHT;
  }

  y += SECTION_GAP;
  y = drawSection(ctx, "学院分布", layout.colleges, COLORS.barCollege, layout.width, y);
  y += SECTION_GAP;
  drawSection(ctx, "年级分布", layout.years, COLORS.barYear, layout.width, y);

  return canvas.toBuffer("image/png");
}

export function drawSection(
  ctx: PixelContext,
  title: string,
  entries: readonly DistributionEntry[],
  color: string,
  width: number,
  startY: number,
): number {
  let y = startY;
  ctx.fillStyle = COLORS.muted;
  ctx.font = `20px ${FONT_FAMILY}`;
  ctx.fillText(title, STATS_PADDING, y);
  y += SECTION_HEADER_HEIGHT;

  if (entries.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `20px ${FONT_FAMILY}`;
    ctx.fillText("（无资料）", STATS_PADDING, y);
    return y + BAR_ROW_HEIGHT;
  }

  const labelWidth = 200;
  const barLeft = STATS_PADDING + labelWidth;
  const barMax = width - STATS_PADDING - barLeft - 60;
  const max = Math.max(...entries.map((entry) => entry.count), 1);
  for (const entry of entries) {
    ctx.fillStyle = COLORS.label;
    ctx.font = `20px ${FONT_FAMILY}`;
    ctx.fillText(truncateText(ctx, entry.label, labelWidth - 10), STATS_PADDING, y + 3);

    ctx.fillStyle = COLORS.barTrack;
    ctx.fillRect(barLeft, y + 3, barMax, BAR_ROW_HEIGHT - 6);
    ctx.fillStyle = color;
    ctx.fillRect(barLeft, y + 3, Math.max(4, (barMax * entry.count) / max), BAR_ROW_HEIGHT - 6);

    ctx.fillStyle = COLORS.muted;
    ctx.font = `18px ${FONT_FAMILY}`;
    ctx.fillText(String(entry.count), barLeft + barMax + 8, y + 4);
    y += BAR_ROW_HEIGHT + BAR_ROW_GAP;
  }
  return y;
}

/** 按可用宽度截断文本，超出补省略号（避免条形图标签压住条形）。 */
export function truncateText(
  ctx: Pick<PixelContext, "measureText">,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

export function normalizeLabel(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "（未填）";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 缺省系统字体探测：同步 `existsSync`（启动/首次渲染时才调用）。 */
export function defaultHasSystemFont(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export function defaultReadFontFile(path: string): Uint8Array | undefined {
  try {
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 动态加载 `@napi-rs/canvas`。
 *
 * 该依赖是**可选**的：沙箱/精简部署里可能根本装不上，因此这里用变量拼包名
 * 动态 `import()`（静态可解析的 `import(...)` 会让 `tsc` 在依赖缺失时直接报
 * 「找不到模块」，把可选依赖变成编译期硬依赖）；加载失败由 `render()` 捕获并
 * 降级为文字统计卡（见类注释）。
 */
export async function loadCanvasModule(): Promise<CanvasModule> {
  const packageName = ["@napi-rs", "canvas"].join("/");
  const module = (await import(packageName)) as unknown as CanvasModule;
  return module;
}
