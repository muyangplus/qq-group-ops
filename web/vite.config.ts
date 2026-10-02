import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/**
 * 管理后台的构建 / 开发配置（E2-a）。
 *
 * 开发期把管理面请求代理到**机器人进程内的回环监听口**（默认 `127.0.0.1:8787`，
 * 见 docs/ADMIN-API.md §2）：浏览器看到的是同源地址，因此不涉及 CORS，
 * `SameSite=Strict` 的会话 cookie 也能直接带上。
 *
 * 端口 / 目标都可用环境变量覆盖（`ADMIN_API_PROXY` / `WEB_PORT`），
 * 免得本机 8787 被占时还得改代码。
 */
const adminTarget = process.env["ADMIN_API_PROXY"] ?? "http://127.0.0.1:8787";
const proxyPrefixes = ["/api", "/auth", "/healthz"];

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // 显式绑 IPv4 回环：默认只监听 `localhost`，在 Windows 上可能只解析到 ::1，
    // 于是 http://127.0.0.1:5173 反而不通（管理后台只该在本机开，别绑 0.0.0.0）
    host: "127.0.0.1",
    port: Number(process.env["WEB_PORT"] ?? 5173),
    proxy: Object.fromEntries(
      proxyPrefixes.map((prefix) => [
        prefix,
        // 管理 API 只在回环上，不需要改 Host（改了反而会让日志里的地址失真）
        { target: adminTarget, changeOrigin: false },
      ]),
    ),
  },
  build: {
    // 产物不进 dist/：CD 默认不发前端，需要时单独 `pnpm web:build` 再交给静态托管
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
