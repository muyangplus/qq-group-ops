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
      "/api/tasks",
      "/api/settings",
      "/api/health",
      "/api/pending",
      "/api/audit",
      "/api/rules",
      "/api/activities",
      // P1 只读补齐
      "/api/punishments",
      "/api/blacklist",
      "/api/appeals",
      "/api/notify/deliveries",
      "/api/join/sync",
    ]) {
      expect(source, `缺少端点 ${endpoint}`).toContain(endpoint);
    }
    // 写端点：审批 / 拒绝 / 活动状态（动作拼在路径尾）/ 恢复配置默认值
    expect(source).toContain("/approve");
    expect(source).toContain("/reject");
    expect(source).toContain("/api/activities/");
    expect(source).toContain("AdminApiActivityAction");
    expect(source).toContain("clearSetting");
    // 审计导出是**同源下载链接**（靠 cookie 鉴权），不是 fetch
    expect(source).toContain("/api/audit/export.csv");
  });

  it("P1 只读页：处罚 / 黑名单 / 申诉 / 投递都挂上了，且都只读", () => {
    const punishments = read("views/PunishmentsView.vue");
    const blacklist = read("views/BlacklistView.vue");
    const appeals = read("views/AppealsView.vue");
    const deliveries = read("views/DeliveriesView.vue");
    const router = read("router.ts");
    const app = read("App.vue");

    expect(punishments).toContain("adminApi.punishments");
    expect(punishments).toContain("MODERATOR_LEVEL");
    expect(blacklist).toContain("adminApi.blacklist");
    // 全局那组看不到时要说明「权限不够」，而不是显示成「全局没人」
    expect(blacklist).toContain("globalVisible");
    expect(appeals).toContain("adminApi.appeals");
    expect(appeals).toContain("holdRemainingMinutes");
    // 复核仍然只在机器人里做：页面上要说清
    expect(appeals).toContain("机器人");
    expect(deliveries).toContain("adminApi.deliveries");
    expect(deliveries).toContain("counts");

    for (const name of ["PunishmentsView", "BlacklistView", "AppealsView", "DeliveriesView"]) {
      expect(router, `路由缺 ${name}`).toContain(name);
    }
    expect(app).toContain("punishments");
    expect(app).toContain("blacklist");
  });

  it("P2 写操作：被处罚 / 被拉黑人 / 申诉人只有二次确认后才动手", () => {
    const punishments = read("views/PunishmentsView.vue");
    const blacklist = read("views/BlacklistView.vue");
    const appeals = read("views/AppealsView.vue");

    // 处罚动作：与指令层同一服务；不可逆动作要写明后果
    expect(punishments).toContain("adminApi.punish");
    expect(punishments).toContain("ModalDialog");
    expect(punishments).toContain("不可逆");
    // 「处置即回应申诉」的连带结果要说给操作者
    expect(punishments).toContain("acceptedAppeals");
    // 全局拉黑只有平台超管能点
    expect(punishments).toContain("isSuperAdmin");

    // 黑名单增删：加入要二次确认、全局项只给超管
    expect(blacklist).toContain("adminApi.addBlacklist");
    expect(blacklist).toContain("adminApi.removeBlacklist");
    expect(blacklist).toContain("ModalDialog");
    expect(blacklist).toContain("所有已绑定群");

    // 申诉复核：通过 = 撤销处罚；理由会私信申诉人
    expect(appeals).toContain("adminApi.decideAppeal");
    expect(appeals).toContain("ModalDialog");
    expect(appeals).toContain("撤销该处罚");
    expect(appeals).toContain("私信");
  });

  it("通知页：门槛（240，二次确认）+ 测试推送（只发自己）+ 订阅口径说明", () => {
    const view = read("views/NotifyView.vue");
    const router = read("router.ts");

    expect(view).toContain("adminApi.notifyTopics");
    expect(view).toContain("adminApi.setNotifyLevel");
    expect(view).toContain("adminApi.resetNotifyLevels");
    expect(view).toContain("adminApi.sendNotifyTest");
    expect(view).toContain("ModalDialog");
    // 门槛是全局的、只有平台超管能改；订阅是个人偏好，仍在机器人里改
    expect(view).toContain("session.isSuperAdmin");
    expect(view).toContain("全局");
    expect(view).toContain("机器人");
    expect(router).toContain("NotifyView");
  });

  it("规则页：关键词增删 + 恢复继承（字段级 / 整群都要确认）", () => {
    const view = read("views/RulesView.vue");

    expect(view).toContain("adminApi.ruleKeywords");
    expect(view).toContain("adminApi.resetRuleFields");
    expect(view).toContain("adminApi.resetRuleGroup");
    // 跳过哪些词、为什么跳过，要如实显示（后端 skipped）
    expect(view).toContain("skipped");
    expect(view).toContain("ModalDialog");
    expect(view).toContain("不可逆");
  });

  it("别名页：平台超管专属，增删都二次确认", () => {
    const view = read("views/AliasesView.vue");
    const router = read("router.ts");
    const app = read("App.vue");

    expect(view).toContain("adminApi.aliases");
    expect(view).toContain("adminApi.setAlias");
    expect(view).toContain("adminApi.removeAlias");
    expect(view).toContain("ModalDialog");
    expect(view).toContain("session.isSuperAdmin");
    // 班级库未加载是最常见的一次性故障，页面上要说清怎么修
    expect(view).toContain("class:index");
    expect(router).toContain("AliasesView");
    expect(app).toContain("aliases");
  });

  it("待审批页：申请人资料摘要 + 同步官方队列（120 起）", () => {
    const source = read("views/PendingView.vue");

    expect(source).toContain("profile");
    expect(source).toContain("adminApi.syncJoinRequests");
    expect(source).toContain("MODERATOR_LEVEL");
  });

  it("审计页：导出 CSV 的同源链接（完整那份只给平台超管）", () => {
    const source = read("views/AuditView.vue");

    expect(source).toContain("adminApi.auditExportUrl");
    expect(source).toContain("full: true");
    expect(source).toContain("session.isSuperAdmin");
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
    // 周期任务监测（/api/tasks）挂在同一个平台级页面上
    expect(view).toContain("adminApi.tasks");
    expect(view).toContain("session.isSuperAdmin");
    // 导航里的「状态」入口同样只在超管时出现
    expect(app).toContain('v-if="session.isSuperAdmin"');
  });

  it("配置页：只有热改项可写，`.env` 只读；同样只给平台超管", () => {
    const view = read("views/SettingsView.vue");
    const app = read("App.vue");

    expect(view).toContain("adminApi.settings");
    expect(view).toContain("adminApi.updateSetting");
    expect(view).toContain("adminApi.clearSetting");
    expect(view).toContain("session.isSuperAdmin");
    // 密钥类不回显：页面上必须明说
    expect(view).toContain("已配置");
    expect(app).toContain("settings");
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
      "SettingsView",
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
