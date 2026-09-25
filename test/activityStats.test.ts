import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { ActivityStatus } from "../src/core/enums.js";
import type { Activity, ActivityRegistration } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import {
  ActivityStatsService,
  buildStatsLayout,
  distributionOf,
  renderStatsImage,
  STATS_FONT_CACHE_FILE,
  STATS_IMAGE_WIDTH,
  SYSTEM_FONT_PATHS,
  truncateText,
  type CanvasModule,
  type PixelCanvas,
  type PixelContext,
} from "../src/services/activityStats.js";
import { RichMessageSender } from "../src/services/richMessages.js";
import type { UserProfile } from "../src/services/userProfiles.js";

/**
 * 活动统计图片（§B3）的降级与排版。
 *
 * 沙箱里装不上 `@napi-rs/canvas`（原生包），所以这里**不依赖真实依赖**：
 * - 「依赖/字体缺失 → `undefined`」是硬断言（调用方据此降级为文字统计卡）；
 * - 排版逻辑用**可注入的渲染函数**与假画布断言（宽度、条形长度、文本截断）。
 */

const GROUP = "g1";

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: "a1",
    code: "ACT001",
    groupId: GROUP,
    groupNumber: "654321",
    title: "迎新晚会",
    createdBy: "admin",
    description: "欢迎新同学",
    links: [],
    capacity: 20,
    allowColleges: [],
    denyColleges: [],
    allowYears: [],
    denyYears: [],
    status: ActivityStatus.Open,
    mentionAll: false,
    notifyCreator: false,
    waitlistPromotion: "manual",
    heldSlots: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRegistration(
  index: number,
  overrides: Partial<ActivityRegistration> = {},
): ActivityRegistration {
  return {
    registrationId: `r${index}`,
    activityId: "a1",
    groupId: GROUP,
    userId: `u${index}`,
    displayName: `同学${index}`,
    note: "",
    createdAt: new Date(`2026-01-0${index}T00:00:00Z`),
    ...overrides,
  };
}

function profileOf(overrides: Partial<UserProfile> & { userId: string }): UserProfile {
  return {
    name: "",
    studentId: "",
    className: "",
    college: "",
    year: "",
    ...overrides,
  };
}

/** 假画布：记录绘制调用，`toBuffer` 返回一个可断言的 PNG 前缀。 */
function createFakeCanvas(): {
  module: CanvasModule;
  fills: Array<[number, number, number, number, string]>;
  texts: string[];
  registered: string[];
  sizes: Array<[number, number]>;
} {
  const fills: Array<[number, number, number, number, string]> = [];
  const texts: string[] = [];
  const registered: string[] = [];
  const sizes: Array<[number, number]> = [];
  const context: PixelContext = {
    fillStyle: "#000000",
    font: "",
    textBaseline: "top",
    fillRect: (x, y, width, height) => {
      fills.push([x, y, width, height, String(context.fillStyle)]);
    },
    fillText: (text) => {
      texts.push(text);
    },
    // 1 字宽 = 1px，便于断言截断
    measureText: (text) => ({ width: text.length }),
  };
  const module: CanvasModule = {
    createCanvas: (width, height) => {
      sizes.push([width, height]);
      const canvas: PixelCanvas = {
        width,
        height,
        getContext: () => context,
        toBuffer: () => Buffer.from([137, 80, 78, 71]),
      };
      return canvas;
    },
    GlobalFonts: {
      registerFromPath: (path) => {
        registered.push(path);
      },
    },
  };
  return { module, fills, texts, registered, sizes };
}

describe("buildStatsLayout", () => {
  const profiles = new Map<string, UserProfile>([
    ["u1", profileOf({ userId: "u1", college: "化学与生命科学学院", year: "22" })],
    ["u2", profileOf({ userId: "u2", college: "化学与生命科学学院", year: "22" })],
    ["u3", profileOf({ userId: "u3", college: "环境科学与工程学院", year: "23" })],
  ]);

  it("aggregates college / year distributions in descending count order", () => {
    const layout = buildStatsLayout({
      activity: makeActivity(),
      registrations: [makeRegistration(1), makeRegistration(2), makeRegistration(3)],
      profiles,
      waitlistCount: 4,
      now: new Date("2026-03-01T00:00:00"),
    });
    expect(layout.width).toBe(STATS_IMAGE_WIDTH);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.colleges).toEqual([
      { label: "化学与生命科学学院", count: 2 },
      { label: "环境科学与工程学院", count: 1 },
    ]);
    expect(layout.years).toEqual([
      { label: "22", count: 2 },
      { label: "23", count: 1 },
    ]);
    // 四个数字：报名 / 候补 / 待释放 / 截止
    expect(layout.facts).toEqual([
      "报名 3 / 20",
      "候补 4",
      "待释放名额 2",
      "截止 不限",
    ]);
  });

  it("marks missing profiles as (未填) and shows closeAt expiry", () => {
    const layout = buildStatsLayout({
      activity: makeActivity({
        closeAt: new Date("2026-01-01T09:05:00"),
        capacity: undefined,
      }),
      registrations: [makeRegistration(1)],
      now: new Date("2026-03-01T00:00:00"),
    });
    expect(layout.facts[0]).toBe("报名 1 人（不限名额）");
    expect(layout.facts[3]).toContain("已截止");
    expect(layout.colleges).toEqual([{ label: "（未填）", count: 1 }]);
  });

  it("sorts equal counts by label and treats blank labels as (未填)", () => {
    expect(distributionOf(["乙", "甲", "乙", "甲"])).toEqual([
      { label: "甲", count: 2 },
      { label: "乙", count: 2 },
    ]);
    expect(distributionOf(["", "  "])).toEqual([{ label: "（未填）", count: 2 }]);
    expect(distributionOf([])).toEqual([]);
  });
});

describe("ActivityStatsService", () => {
  const profiles = new Map<string, UserProfile>([
    ["u1", profileOf({ userId: "u1", college: "化学与生命科学学院", year: "22" })],
  ]);

  it("degrades to undefined when no system font, no cache and no download url", async () => {
    const canvasLoader = vi.fn();
    const service = new ActivityStatsService({
      hasSystemFont: () => false,
      readFontFile: () => undefined,
      fontUrl: "",
      fontCacheDir: join(tmpdir(), "qq-group-ops-missing-fonts"),
      canvasLoader,
      fetchImpl: (() => {
        throw new Error("must not download");
      }) as unknown as typeof fetch,
    });

    await expect(
      service.render(makeActivity(), [makeRegistration(1)], profiles),
    ).resolves.toBeUndefined();
    // 没有字体就不该去加载可选依赖
    expect(canvasLoader).not.toHaveBeenCalled();
  });

  it("degrades to undefined when the optional canvas dependency is missing", async () => {
    const service = new ActivityStatsService({
      hasSystemFont: (path) => path === SYSTEM_FONT_PATHS[0],
      canvasLoader: async () => {
        throw new Error("Cannot find module @napi-rs/canvas");
      },
    });

    await expect(
      service.render(makeActivity(), [makeRegistration(1)], profiles),
    ).resolves.toBeUndefined();
  });

  it("degrades when the font download fails instead of throwing", async () => {
    const service = new ActivityStatsService({
      hasSystemFont: () => false,
      readFontFile: () => undefined,
      fontUrl: "https://example.com/font.otf",
      fontCacheDir: join(tmpdir(), "qq-group-ops-download-fail"),
      canvasLoader: async () => {
        throw new Error("should not be reached");
      },
      fetchImpl: (async () => ({
        ok: false,
        status: 503,
        arrayBuffer: async () => new ArrayBuffer(0),
      })) as unknown as typeof fetch,
    });

    await expect(
      service.render(makeActivity(), [makeRegistration(1)], profiles),
    ).resolves.toBeUndefined();
  });

  it("prefers the system font and never downloads", async () => {
    const canvas = createFakeCanvas();
    const fetchImpl = vi.fn();
    const systemFont = SYSTEM_FONT_PATHS[0]!;
    const service = new ActivityStatsService({
      hasSystemFont: (path) => path === systemFont,
      readFontFile: () => undefined,
      fontUrl: "https://example.com/font.otf",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      canvasLoader: async () => canvas.module,
    });

    const png = await service.render(makeActivity(), [makeRegistration(1)], profiles);
    expect(png).toBeInstanceOf(Buffer);
    expect(canvas.registered).toEqual([systemFont]);
    expect(fetchImpl).not.toHaveBeenCalled();
    // 画布宽度固定 720，高度自适应
    expect(canvas.sizes[0]?.[0]).toBe(STATS_IMAGE_WIDTH);
    expect(canvas.texts).toContain("活动统计");
    expect(canvas.texts).toContain("ACT001 · 迎新晚会");
    expect(canvas.texts).toContain("报名 1 / 20");
    expect(canvas.texts).toContain("候补 0");
    expect(canvas.texts).toContain("待释放名额 2");
    expect(canvas.texts).toContain("学院分布");
    expect(canvas.texts).toContain("年级分布");
    expect(canvas.texts).toContain("化学与生命科学学院");
    expect(canvas.texts).toContain("22");
  });

  it("downloads and caches the font when no system font exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-group-ops-font-cache-"));
    const canvas = createFakeCanvas();
    const fontBytes = Uint8Array.from([1, 2, 3, 4]);
    try {
      const service = new ActivityStatsService({
        hasSystemFont: () => false,
        fontCacheDir: dir,
        fontUrl: "https://example.com/font.otf",
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => fontBytes.buffer,
        })) as unknown as typeof fetch,
        canvasLoader: async () => canvas.module,
      });

      await service.render(makeActivity(), [makeRegistration(1)], profiles);

      const cachedPath = join(dir, STATS_FONT_CACHE_FILE);
      expect(canvas.registered).toEqual([cachedPath]);
      // 再渲染一次应命中缓存（不再下载）
      const second = new ActivityStatsService({
        hasSystemFont: () => false,
        fontCacheDir: dir,
        fontUrl: "https://example.com/font.otf",
        fetchImpl: (() => {
          throw new Error("must reuse cache");
        }) as unknown as typeof fetch,
        canvasLoader: async () => canvas.module,
      });
      await expect(
        second.render(makeActivity(), [makeRegistration(1)], profiles),
      ).resolves.toBeInstanceOf(Buffer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the cached font file when present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-group-ops-font-present-"));
    const canvas = createFakeCanvas();
    try {
      writeFileSync(join(dir, STATS_FONT_CACHE_FILE), Buffer.from([9, 9]));
      const service = new ActivityStatsService({
        hasSystemFont: () => false,
        fontCacheDir: dir,
        fontUrl: "https://example.com/font.otf",
        fetchImpl: (() => {
          throw new Error("must use cache");
        }) as unknown as typeof fetch,
        canvasLoader: async () => canvas.module,
      });

      await service.render(makeActivity(), [makeRegistration(1)], profiles);
      expect(canvas.registered).toEqual([join(dir, STATS_FONT_CACHE_FILE)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades when the injected render function throws", async () => {
    const service = new ActivityStatsService({
      hasSystemFont: (path) => path === SYSTEM_FONT_PATHS[0],
      canvasLoader: async () => createFakeCanvas().module,
      renderFn: async () => {
        throw new Error("boom");
      },
    });

    await expect(
      service.render(makeActivity(), [makeRegistration(1)], profiles),
    ).resolves.toBeUndefined();
  });

  it("sends the rendered PNG through the group image API", async () => {
    const api = new FakeQQOfficialAPI();
    const service = new ActivityStatsService({
      api,
      hasSystemFont: (path) => path === SYSTEM_FONT_PATHS[0],
      canvasLoader: async () => createFakeCanvas().module,
    });

    const png = await service.render(makeActivity(), [], profiles);
    expect(png).toBeDefined();
    const sent = await service.sendImageToGroup(GROUP, png!, "activity-ACT001.png");
    expect(sent).toEqual({ ok: true, detail: "" });
    expect(api.uploadedGroupImages).toEqual([
      [GROUP, "activity-ACT001.png", png],
    ]);
    expect(api.sentGroupImages[0]?.[0]).toBe(GROUP);
    expect(api.sentGroupImages[0]?.[1]).toBe(
      String(api.uploadedGroupImages[0] ? "fake-file-info-1" : ""),
    );
  });

  it("reports failure when the image upload fails", async () => {
    const api = new FakeQQOfficialAPI();
    api.failGroupImages = true;
    const service = new ActivityStatsService({ api });

    const sent = await service.sendImageToGroup(
      GROUP,
      Buffer.from([137, 80, 78, 71]),
      "x.png",
    );
    expect(sent.ok).toBe(false);
    expect(sent.detail).toContain("failure");
  });

  it("reports failure when no send channel is wired", async () => {
    const service = new ActivityStatsService();
    expect(service.canSend).toBe(false);
    const sent = await service.sendImageToGroup(
      GROUP,
      Buffer.from([1]),
      "x.png",
    );
    expect(sent).toEqual({ ok: false, detail: "未装配群图片发送通道" });
  });
});

describe("renderStatsImage", () => {
  it("draws a bar per distribution entry with proportional width", async () => {
    const canvas = createFakeCanvas();
    const input = {
      activity: makeActivity(),
      registrations: [
        makeRegistration(1),
        makeRegistration(2),
        makeRegistration(3),
      ],
      profiles: new Map<string, UserProfile>([
        ["u1", profileOf({ userId: "u1", college: "甲学院", year: "22" })],
        ["u2", profileOf({ userId: "u2", college: "甲学院", year: "22" })],
        ["u3", profileOf({ userId: "u3", college: "乙学院", year: "23" })],
      ]),
    };

    const png = await renderStatsImage(canvas.module, input);
    expect(png).toBeInstanceOf(Buffer);
    expect(canvas.texts).toContain("甲学院");
    expect(canvas.texts).toContain("乙学院");
    // 1 个背景 + 4 个底轨（#F0F2F5）+ 4 个数据条（#3370FF / #00B42A）
    expect(canvas.fills).toHaveLength(9);
    expect(canvas.fills.filter(([, , , , color]) => color === "#F0F2F5")).toHaveLength(4);
    // 数据条按比例：甲学院 2 人（满宽）比 乙学院 1 人（半宽）宽
    const collegeBars = canvas.fills.filter(([, , , , color]) => color === "#3370FF");
    expect(collegeBars).toHaveLength(2);
    expect(collegeBars[0]![2]).toBeGreaterThan(collegeBars[1]![2]);
    // 年级条形用另一套颜色
    expect(canvas.fills.filter(([, , , , color]) => color === "#00B42A")).toHaveLength(2);
  });

  it("shows an empty-state line when a distribution has no data", async () => {
    const canvas = createFakeCanvas();
    await renderStatsImage(canvas.module, {
      activity: makeActivity(),
      registrations: [],
    });
    expect(canvas.texts.filter((text) => text === "（无资料）")).toHaveLength(2);
  });
});

describe("truncateText", () => {
  it("keeps short text and appends an ellipsis when too long", () => {
    const ctx = { measureText: (text: string) => ({ width: text.length }) };
    expect(truncateText(ctx, "短", 10)).toBe("短");
    // 10 字 > 5 → 截到 4 字 + 省略号（避免出现「未登记的 9-12 位数字」）
    expect(truncateText(ctx, "2212 3456", 5)).toBe("2212…");
  });
});

describe("ActivityExportService", () => {
  const profiles = {
    get: (userId: string): UserProfile | undefined =>
      new Map<string, UserProfile>([
        [
          "u1",
          profileOf({
            userId: "u1",
            studentId: "22123456789",
            className: "材化2211",
            college: "化学与生命科学学院",
          }),
        ],
      ]).get(userId),
  };

  function waitlist(index: number) {
    return {
      activityId: "a1",
      userId: `w${index}`,
      displayName: `候补${index}`,
      note: "",
      createdAt: new Date(`2026-02-0${index}T00:00:00Z`),
    };
  }

  it("builds the confirmed CSV columns with a waitlist flag", () => {
    const service = new ActivityExportService({ profiles });
    const csv = service.buildCsv({
      activity: makeActivity(),
      registrations: [makeRegistration(1, { note: "想参加" })],
      waitlist: [waitlist(1)],
      operatorId: "admin",
    });

    const [header, ...rows] = csv.trimEnd().split("\n");
    expect(header).toBe("序号,姓名,学号,班级,学院,备注,候补");
    expect(rows[0]).toBe("1,同学1,22123456789,材化2211,化学与生命科学学院,想参加,");
    expect(rows[1]).toBe("2,候补1,,,,,候补");
    // 末尾保留换行，方便直接落成文件
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("quotes fields containing commas or quotes", () => {
    const service = new ActivityExportService({ profiles });
    const csv = service.buildCsv({
      activity: makeActivity(),
      registrations: [makeRegistration(1, { displayName: '同学"甲"', note: "第一名, 好" })],
      operatorId: "admin",
    });
    expect(csv).toContain('"同学""甲"""');
    expect(csv).toContain('"第一名, 好"');
  });

  it("sends the CSV as a private message instead of a group card", async () => {
    const api = new FakeQQOfficialAPI();
    const service = new ActivityExportService({
      sender: new RichMessageSender(api),
      profiles,
    });

    const result = await service.exportCsv({
      activity: makeActivity(),
      registrations: [makeRegistration(1)],
      waitlist: [],
      operatorId: "admin",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已私信导出 1 行 CSV");
    expect(api.sentMessages).toHaveLength(0);
    const dm = api.sentPrivateMessages[0];
    expect(dm?.userOpenid).toBe("admin");
    expect(String(dm?.content)).toContain("序号,姓名,学号,班级,学院,备注,候补");
    expect(String(dm?.content)).toContain("22123456789");
  });

  it("tells the operator to use /export when the CSV is too long", async () => {
    const api = new FakeQQOfficialAPI();
    const service = new ActivityExportService({
      sender: new RichMessageSender(api),
      profiles,
      messageLimit: 10,
    });

    const result = await service.exportCsv({
      activity: makeActivity(),
      registrations: [makeRegistration(1)],
      operatorId: "admin",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("/export");
    const content = String(api.sentPrivateMessages[0]?.content ?? "");
    expect(content).toContain("/export #ACT001");
    // 超长时不再塞 CSV 本体
    expect(content).not.toContain("序号,姓名");
  });

  it("reports failure when the private channel is unavailable", async () => {
    const api = new FakeQQOfficialAPI();
    api.failPrivateMessages = true;
    const service = new ActivityExportService({ sender: new RichMessageSender(api) });

    const result = await service.exportCsv({
      activity: makeActivity(),
      registrations: [makeRegistration(1)],
      operatorId: "admin",
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("私信失败");
  });

  it("reports failure when no sender is wired", async () => {
    const service = new ActivityExportService();
    const result = await service.exportCsv({
      activity: makeActivity(),
      registrations: [],
      operatorId: "admin",
    });
    expect(result).toEqual({ ok: false, text: "发送通道未启用，无法私信 CSV。" });
  });
});
