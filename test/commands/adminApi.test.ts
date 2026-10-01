import { describe, expect, it } from "vitest";

import { AdminApiLinkService } from "../../src/adminApi/loginLink.js";
import { loadAdminApiConfig } from "../../src/adminApi/config.js";
import { AdminCommandService } from "../../src/services/adminCommands.js";
import type { AdminTokenRepository } from "../../src/db/adminTokenRepository.js";
import {
  appeals,
  auditLog,
  blacklist,
  configStore,
  identityMap,
  joinApproval,
  joinAudit,
  joinSync,
  moderationNotifier,
  notifications,
  permissions,
  punishments,
} from "../helpers/adminCommandsHarness.js";

/**
 * `/admin login`（E1-b）：只在私信、只有平台超管；签出一次性令牌与登录链接。
 */

const ENABLED_CONFIG = loadAdminApiConfig({
  ADMIN_API_ENABLED: "true",
  ADMIN_API_SESSION_SECRET: "z".repeat(40),
  ADMIN_API_PUBLIC_BASE_URL: "https://ops.example.com",
});

const DISABLED_CONFIG = loadAdminApiConfig({});

function memoryTokens(): AdminTokenRepository {
  let issued = 0;
  return {
    async issue({ userId, now }) {
      issued += 1;
      const token = `tok-${issued}`;
      const expiresAt = new Date((now?.getTime() ?? Date.now()) + 60_000);
      return { token, expiresAt };
    },
    async redeem() {
      return undefined;
    },
    async pruneExpired() {},
  };
}

function build(config = ENABLED_CONFIG, tokens?: AdminTokenRepository) {
  return new AdminCommandService({
    permissions,
    joinAudit,
    configStore,
    joinApproval,
    joinSync,
    auditLog,
    identityMap,
    notifications,
    blacklist,
    punishments,
    appeals,
    moderationNotifier,
    adminApi: new AdminApiLinkService({
      tokens: tokens ?? memoryTokens(),
      config,
      permissions,
    }),
  });
}

describe("/admin login", () => {
  it("群里不签发（令牌不能贴到全群）", async () => {
    const result = await build().handle("g1", "root", "/admin login");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("只在私信执行");
  });

  it("非平台超管拒绝", async () => {
    const result = await build().handle(undefined, "admin", "/admin login");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("超管私信签发：卡片带令牌与登录链接，并提示一次性", async () => {
    const result = await build().handle(undefined, "root", "/admin login");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("tok-1");
    expect(result.text).toContain("https://ops.example.com/login?token=tok-1");
    expect(result.text).toContain("只能用一次");
  });

  it("没配 PUBLIC_BASE_URL 时只给令牌", async () => {
    const config = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: "z".repeat(40),
    });
    const result = await build(config).handle(undefined, "root", "/admin login");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("tok-1");
    expect(result.text).toContain("ADMIN_API_PUBLIC_BASE_URL");
    expect(result.text).not.toContain("https://");
  });

  it("管理 API 未开启时明确说明", async () => {
    const result = await build(DISABLED_CONFIG).handle(undefined, "root", "/admin login");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("未开启");
  });

  it("白名单配置后只允许名单内的人签发", async () => {
    const config = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: "z".repeat(40),
      ADMIN_API_ALLOWED_OPENIDS: "someone-else",
    });
    const result = await build(config).handle(undefined, "root", "/admin login");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("/admin status 只报告状态", async () => {
    const result = await build().handle(undefined, "root", "/admin status");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已开启");
    expect(result.text).not.toContain("tok-");
  });
});
