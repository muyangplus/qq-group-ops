import type { CanvasModule, PixelContext } from "../../src/services/activityStats.js";

/**
 * 最小 canvas 桩（`@napi-rs/canvas` 在沙箱里装不上）。
 *
 * 只满足 `ActivityStatsService.render` 用到的面：测量文本 + 画矩形 + 导出 PNG。
 * 统计图的排版逻辑由 `test/activityStats.test.ts` 的假画布单独断言。
 */
export function stubCanvasModule(): CanvasModule {
  const context: PixelContext = {
    fillStyle: "#000000",
    font: "",
    textBaseline: "top",
    fillRect: () => {},
    fillText: () => {},
    measureText: (text) => ({ width: text.length }),
  };
  return {
    createCanvas: (width, height) => ({
      width,
      height,
      getContext: () => context,
      toBuffer: () => Buffer.from([137, 80, 78, 71]),
    }),
    GlobalFonts: { registerFromPath: () => {} },
  };
}
