import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 管理后台脚手架的守卫（E2-a）。
 *
 * 这些断言不值钱但很划算：前端是**独立安装**的一套依赖（`pnpm web:install`，
 * 不在根 `pnpm install` 里），很容易在改动中悄悄跑不起来 —— 至少保证入口脚本、
 * 代理目标、`onlyBuiltDependencies` 这三件事不会被人顺手删掉。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${ROOT}${relative}`, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("管理后台脚手架（E2-a）", () => {
  it("根 package.json 暴露 web:install / dev / build / typecheck 四个入口", () => {
    const scripts = readJson("package.json")["scripts"] as Record<string, string>;

    expect(scripts["web:install"]).toBe("pnpm --dir web install");
    expect(scripts["web:dev"]).toBe("pnpm --dir web run dev");
    // 构建必须先过一遍 vue-tsc：单测看不见前端的类型错误
    expect(scripts["web:build"]).toBe("pnpm --dir web run build");
    expect(scripts["web:typecheck"]).toBe("pnpm --dir web run typecheck");
    expect(scripts["build"]).toBe("tsc -p tsconfig.json");
  });

  it("web/package.json：依赖齐全，build 里带类型检查", () => {
    const web = readJson("web/package.json");
    const deps = {
      ...(web["dependencies"] as Record<string, string>),
      ...(web["devDependencies"] as Record<string, string>),
    };
    for (const name of [
      "vue",
      "vue-router",
      "pinia",
      "vite",
      "@vitejs/plugin-vue",
      "typescript",
      "vue-tsc",
    ]) {
      expect(deps[name], `缺少依赖 ${name}`).toBeDefined();
    }
    const scripts = web["scripts"] as Record<string, string>;
    expect(scripts["build"]).toContain("vue-tsc --noEmit");
    expect(scripts["build"]).toContain("vite build");
  });

  it("开发期把管理面请求代理到机器人进程内的回环监听口（可覆盖）", () => {
    const config = readFileSync(`${ROOT}web/vite.config.ts`, "utf8");

    // 三个前缀都要代理：只读 / 写端点在 /api，登录在 /auth，健康检查是 /healthz
    for (const prefix of ["/api", "/auth", "/healthz"]) {
      expect(config).toContain(`"${prefix}"`);
    }
    expect(config).toContain("127.0.0.1:8787");
    expect(config).toContain("ADMIN_API_PROXY");
    expect(config).toContain("WEB_PORT");
  });

  it("产物不进仓库：dist / node_modules 由根 .gitignore 覆盖", () => {
    const ignore = readFileSync(`${ROOT}.gitignore`, "utf8");

    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain("dist/");
  });

  it("pnpm 12 的构建脚本白名单：只放行 esbuild（否则 install 直接失败）", () => {
    const workspace = readFileSync(`${ROOT}web/pnpm-workspace.yaml`, "utf8");

    expect(workspace).toContain("allowBuilds:");
    expect(workspace).toContain("esbuild: true");
  });

  it("index.html 不让搜索引擎收录（管理面只该在回环 / 反代后面）", () => {
    const html = readFileSync(`${ROOT}web/index.html`, "utf8");

    expect(html).toContain('name="robots"');
    expect(html).toContain("noindex");
  });
});

/**
 * 前端 ↔ 后端的**契约**（E2-c）。
 *
 * 前端没有单测（要靠浏览器），但最容易出错的是「页面调的 URL / 参数与后端不一致」——
 * 那些是纯字符串，扫一遍源码就能钉住。真正的权限与校验在服务端，这里只保证不改错端点。
 */
describe("管理前台与后端的接口契约（E2-c）", () => {
  const read = (relative: string): string =>
    readFileSync(`${ROOT}web/src/${relative}`, "utf8");

  it("api/admin.ts 覆盖全部已实现的端点", () => {
    const source = read("api/admin.ts");

    for (const endpoint of [
      "/api/status",
      "/api/pending",
      "/api/audit",
      "/api/rules",
      "/api/activities",
    ]) {
      expect(source, `缺少端点 ${endpoint}`).toContain(endpoint);
    }
    // 写端点：审批 / 拒绝 / 活动状态（动作拼在路径尾）
    expect(source).toContain("/approve");
    expect(source).toContain("/reject");
    expect(source).toContain("/api/activities/");
    expect(source).toContain("AdminApiActivityAction");
  });

  it("待审批页：列表 + 二次确认弹窗 + 按 130 禁用按钮", () => {
    const source = read("views/PendingView.vue");

    expect(source).toContain("adminApi.pending");
    expect(source).toContain("adminApi.approveJoin");
    expect(source).toContain("adminApi.rejectJoin");
    // 通过 / 拒绝各一个确认弹窗（不共用状态）
    expect(source.match(/ModalDialog/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain("GROUP_ADMIN_LEVEL");
  });

  it("状态页：只对平台超管发请求（服务端也会 403）", () => {
    const view = read("views/StatusView.vue");
    const app = read("App.vue");

    expect(view).toContain("adminApi.status");
    expect(view).toContain("session.isSuperAdmin");
    // 导航里的「状态」入口同样只在超管时出现
    expect(app).toContain('v-if="session.isSuperAdmin"');
  });

  it("路由表已挂上已落地的页面", () => {
    const source = read("router.ts");

    for (const view of [
      "DashboardView",
      "PendingView",
      "AuditView",
      "RulesView",
      "ActivitiesView",
      "StatusView",
      "LoginView",
    ]) {
      expect(source).toContain(view);
    }
  });

  it("审计页：非超管必须先选群（服务端不带 group 回 400）", () => {
    const source = read("views/AuditView.vue");

    expect(source).toContain("adminApi.audit");
    expect(source).toContain("MODERATOR_LEVEL");
    expect(source).toContain("needsGroup");
  });

  it("规则页：读用 120 / 写用 130，提交前给 diff", () => {
    const source = read("views/RulesView.vue");

    expect(source).toContain("adminApi.rules");
    expect(source).toContain("adminApi.updateRule");
    expect(source).toContain("GROUP_ADMIN_LEVEL");
    // 全局规则要平台超管（服务端也是这个口径）
    expect(source).toContain("__default__");
    expect(source).toContain("diff");
    expect(source).toContain("ModalDialog");
  });

  it("活动页：三个状态动作 + 名单 CSV 下载链接", () => {
    const source = read("views/ActivitiesView.vue");

    expect(source).toContain("adminApi.activities");
    expect(source).toContain("adminApi.setActivityStatus");
    for (const action of ["open", "close", "cancel"]) {
      expect(source).toContain(`'${action}'`);
    }
    // 脱敏 / 完整两种导出，都是同源下载链接（靠 cookie 鉴权）
    expect(source).toContain("export.csv");
    expect(source).toContain("?full=1");
    expect(source).toContain("GROUP_ADMIN_LEVEL");
  });
});
