import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadAdminApiConfig } from "../src/adminApi/config.js";
import { buildAdminApiServer } from "../src/adminApi/server.js";
import type { AdminTokenRepository } from "../src/db/adminTokenRepository.js";

/**
 * 管理前台静态托管（E2-e 补充）。
 *
 * 真机事故：把整个域名反代到管理端口后，访问 `https://<域名>/login` 与 `/` 都拿到
 * `401 {"error":"unauthorized","message":"请先登录…"}` —— 因为当时服务只做 API，
 * 未匹配的路径也会先过鉴权钩子。现在两件事都修了：
 * 1）非接口路径不鉴权（走 404，且文案说清页面该由谁提供）；
 * 2）管理 API 自己就能托管 `web/dist`（`/`、`/login`、`/assets/*`），
 *    于是「整个域名反代到 8787」这种最省事的部署直接可用。
 */
const CONFIG = loadAdminApiConfig({
  ADMIN_API_ENABLED: "true",
  ADMIN_API_SESSION_SECRET: "y".repeat(40),
});

function memoryTokens(): AdminTokenRepository {
  return {
    async issue() {
      return { token: "t", expiresAt: new Date(Date.now() + 60_000) };
    },
    async redeem() {
      return undefined;
    },
    async pruneExpired() {
      // 不涉及
    },
    async countActive() {
      return 0;
    },
  };
}

describe("管理前台静态托管", () => {
  let dir = "";
  let webRoot = "";
  let app: ReturnType<typeof buildAdminApiServer>["app"];
  let bare: ReturnType<typeof buildAdminApiServer>["app"];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "qqops-webui-"));
    webRoot = join(dir, "web");
    mkdirSync(join(webRoot, "assets"), { recursive: true });
    writeFileSync(join(webRoot, "index.html"), "<!DOCTYPE html><div id=app></div>", "utf8");
    writeFileSync(join(webRoot, "assets", "index-abc.js"), "console.log(1)", "utf8");
    writeFileSync(join(dir, "secret.txt"), "不该被读到", "utf8");

    app = buildAdminApiServer({
      config: CONFIG,
      tokens: memoryTokens(),
      version: "test",
      webRoot,
    }).app;
    // 没配静态目录（或目录不存在）时：行为要跟以前一样 —— 页面路径 404
    bare = buildAdminApiServer({
      config: CONFIG,
      tokens: memoryTokens(),
      version: "test",
      webRoot: join(dir, "nope"),
    }).app;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("托管 index：`/` 与 SPA 路由都回 index.html", async () => {
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain("id=app");

    const spa = await app.inject({ method: "GET", url: "/login?token=abc" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("id=app");
  });

  it("带哈希的 assets 长缓存；index.html 不缓存", async () => {
    const asset = await app.inject({ method: "GET", url: "/assets/index-abc.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");

    const index = await app.inject({ method: "GET", url: "/login" });
    expect(index.headers["cache-control"]).toBe("no-cache");
  });

  it("缺失的资源不回退 HTML；路径穿越被挡", async () => {
    const missing = await app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "not_found" });

    const traversal = await app.inject({ method: "GET", url: "/../secret.txt" });
    expect([403, 404]).toContain(traversal.statusCode);
    expect(traversal.body).not.toContain("不该被读到");
  });

  it("接口路径不受静态托管影响：未登录仍是 401", async () => {
    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(401);
    expect(status.json()).toMatchObject({ error: "unauthorized" });
  });

  it("没配 / 不存在的静态目录：页面路径回 404（并提示页面该由谁提供）", async () => {
    const page = await bare.inject({ method: "GET", url: "/login" });
    expect(page.statusCode).toBe(404);
    expect(page.json()).toMatchObject({ error: "not_found" });

    const root = await bare.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);
    expect(root.json<{ message: string }>().message).toContain("web/dist");
  });
});
