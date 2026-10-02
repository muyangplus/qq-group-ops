import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * 管理前台的**组件测试**配置（P2「前端组件测试底座」）。
 *
 * 与 `vite.config.ts` 分开：这里只多一个 `test` 段（jsdom + `src/**\/*.spec.ts`）。
 * 插件与 `@` 别名保持一致，保证测试里的解析路径与真实构建同路。
 *
 * 只跑 `src/**` 下的单测；根目录 `test/` 里那批扫源码的契约守卫仍由根 vitest 跑
 * （`pnpm test`），两边互不干扰。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    // 补 jsdom 缺的原生 dialog 行为（ModalDialog 用它），其余什么都不动
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});
