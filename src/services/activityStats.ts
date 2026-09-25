import { DEFAULT_ACTIVITY_STATS_FONT_URL } from "../config.js";
import type {
  Activity,
  ActivityRegistration,
} from "./activity.js";
import {
  log,
  STATS_FONT_CACHE_DIR,
  STATS_FONT_CACHE_FILE,
  STATS_FONT_DOWNLOAD_TIMEOUT_MS,
  SYSTEM_FONT_PATHS,
  ActivityStatsRenderInput,
  ActivityStatsServiceOptions,
  StatsImageApi,
  CanvasModule,
  ResolvedStatsFont,
  renderStatsImage,
  messageOf,
  defaultHasSystemFont,
  defaultReadFontFile,
  loadCanvasModule,
} from "./activityStatsCore.js";
import type { UserProfile } from "./userProfiles.js";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";

export { STATS_FONT_CACHE_DIR, STATS_FONT_CACHE_FILE, STATS_FONT_DOWNLOAD_TIMEOUT_MS, STATS_IMAGE_WIDTH, STATS_PADDING, SYSTEM_FONT_PATHS, buildStatsLayout, distributionOf, renderStatsImage, truncateText } from "./activityStatsCore.js";
export type { ActivityStatsRenderInput, ActivityStatsServiceOptions, CanvasModule, DistributionEntry, PixelCanvas, PixelContext, ResolvedStatsFont, StatsImageApi, StatsLayout } from "./activityStatsCore.js";

/**
 * activityStats 服务主体（类型、常量与纯函数见 activityStatsCore.ts）。
 */

export class ActivityStatsService {
  private readonly api: StatsImageApi | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly hasSystemFont: (path: string) => boolean;
  private readonly readFontFile: (path: string) => Uint8Array | undefined;
  private readonly fontCacheDir: string;
  private readonly fontUrl: string;
  private readonly canvasLoader: () => Promise<CanvasModule>;
  private readonly renderFn: ((input: ActivityStatsRenderInput) => Promise<Buffer>) | undefined;
  private readonly now: () => Date;
  /** 字体解析结果（成功才缓存；失败允许下次重试下载）。 */
  private fontPromise: Promise<ResolvedStatsFont | undefined> | undefined;

  public constructor(options: ActivityStatsServiceOptions = {}) {
    this.api = options.api;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.hasSystemFont = options.hasSystemFont ?? defaultHasSystemFont;
    this.readFontFile = options.readFontFile ?? defaultReadFontFile;
    this.fontCacheDir = options.fontCacheDir ?? STATS_FONT_CACHE_DIR;
    this.fontUrl = options.fontUrl ?? DEFAULT_ACTIVITY_STATS_FONT_URL;
    this.canvasLoader = options.canvasLoader ?? loadCanvasModule;
    this.renderFn = options.renderFn;
    this.now = options.now ?? (() => new Date());
  }

  /** 是否具备「把图片发到群里」的能力（管理卡据此生成按钮）。 */
  public get canSend(): boolean {
    return this.api !== undefined;
  }

  /**
   * 渲染统计图；拿不到依赖或字体时返回 `undefined`（调用方降级为文字统计卡）。
   *
   * **任何**异常都被吞掉并转成 `undefined`：统计图是可选的锦上添花，
   * 不能因为它出错就让活动回调失败。
   */
  public async render(
    activity: Activity,
    registrations: readonly ActivityRegistration[],
    profiles?: ReadonlyMap<string, UserProfile> | undefined,
  ): Promise<Buffer | undefined> {
    try {
      const font = await this.resolveFont();
      if (!font) {
        log.info("activity stats font unavailable, degrading to text stats");
        return undefined;
      }
      const canvas = await this.canvasLoader();
      canvas.GlobalFonts.registerFromPath(font.path);
      const render = this.renderFn ?? ((input) => renderStatsImage(canvas, input));
      return await render({
        activity,
        registrations,
        profiles,
        now: this.now(),
      });
    } catch (error) {
      log.warn("activity stats render unavailable, degrading to text stats", {
        activityId: activity.activityId,
        error: messageOf(error),
      });
      return undefined;
    }
  }

  /**
   * 把渲染好的 PNG 上传并发到活动群（官方 `msg_type=7` 富媒体消息）。
   *
   * 未注入 API 或上传/发送失败时返回 `{ ok: false }`，由调用方降级为文字统计卡。
   */
  public async sendImageToGroup(
    groupId: string,
    png: Buffer,
    fileName: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const api = this.api;
    if (!api) {
      return { ok: false, detail: "未装配群图片发送通道" };
    }
    try {
      const uploaded = await api.uploadGroupImage(groupId, fileName, png);
      const fileInfo = uploaded.file_info;
      if (typeof fileInfo !== "string" || fileInfo.length === 0) {
        return { ok: false, detail: "上传响应缺少 file_info" };
      }
      await api.sendGroupImage(groupId, fileInfo);
      log.info("activity stats image sent", { groupId, fileName });
      return { ok: true, detail: "" };
    } catch (error) {
      const detail = messageOf(error);
      log.warn("activity stats image delivery failed", { groupId, error: detail });
      return { ok: false, detail };
    }
  }

  /**
   * 解析可用字体：系统路径优先 → 缓存文件 → 下载。
   *
   * 解析结果（含失败）只缓存一次；失败时清空缓存，允许后续请求重试下载。
   */
  private resolveFont(): Promise<ResolvedStatsFont | undefined> {
    this.fontPromise ??= this.resolveFontOnce().catch((error: unknown) => {
      this.fontPromise = undefined;
      log.warn("activity stats font resolution failed", {
        error: messageOf(error),
      });
      return undefined;
    });
    return this.fontPromise;
  }

  private async resolveFontOnce(): Promise<ResolvedStatsFont | undefined> {
    for (const path of SYSTEM_FONT_PATHS) {
      if (this.hasSystemFont(path)) {
        log.debug("activity stats using system font", { path });
        return { path, source: "system" };
      }
    }
    const cached = join(this.fontCacheDir, STATS_FONT_CACHE_FILE);
    if (this.readFontFile(cached)) {
      log.debug("activity stats using cached font", { path: cached });
      return { path: cached, source: "cache" };
    }
    const url = this.fontUrl.trim();
    if (url.length === 0) {
      log.info("no system font and ACTIVITY_STATS_FONT_URL is empty, degrading");
      return undefined;
    }
    try {
      const data = await this.downloadFont(url);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, data);
      log.info("activity stats font downloaded and cached", {
        path: cached,
        bytes: data.byteLength,
      });
      return { path: cached, source: "download" };
    } catch (error) {
      log.warn("activity stats font download failed, degrading to text stats", {
        url,
        error: messageOf(error),
      });
      return undefined;
    }
  }

  private async downloadFont(url: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(STATS_FONT_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`font download failed: HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new Error("font download returned empty body");
    }
    return new Uint8Array(buffer);
  }
}

// ---------------------------------------------------------------------------
// 排版（纯函数，测试可注入 canvas 断言）
// ---------------------------------------------------------------------------
