import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadAdminApiConfig,
  machineTokenAllows,
  parseMachineTokens,
  type AdminApiMachineToken,
} from "../src/adminApi/config.js";
import {
  ADMIN_API_KNOWN_SCOPES,
  ADMIN_API_ROUTE_SCOPES,
  ADMIN_API_SCOPE_DOMAINS,
  requiredScopeFor,
} from "../src/adminApi/scopes.js";

/**
 * 机器令牌的**细粒度 scope**（P2：管理 API 机器令牌收窄）。
 *
 * 三条口径：
 * - `*` / `read` / `write` 是通配（老 token 行为不变）；
 * - `read:<域>` / `write:<域>` 精确到域，**不会**因为前缀相同就顺带放行别的域；
 * - 没登记的端点回落到 `read` / `write` → 细粒度 token 访问不了（fail-closed）。
 */

function token(scopes: readonly string[], expiresAt?: Date): AdminApiMachineToken {
  return {
    token: "t".repeat(16),
    scopes,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

describe("端点 → scope 登记", () => {
  it("常见端点按域判定", () => {
    expect(requiredScopeFor("GET", "/api/pending")).toBe("read:join");
    expect(requiredScopeFor("POST", "/api/pending/:requestId/approve")).toBe("write:join");
    expect(requiredScopeFor("GET", "/api/audit")).toBe("read:audit");
    expect(requiredScopeFor("GET", "/api/audit/export.csv")).toBe("read:audit");
    expect(requiredScopeFor("POST", "/api/punishments/:code/:action")).toBe("write:punish");
    expect(requiredScopeFor("POST", "/api/activities")).toBe("write:activity");
    expect(requiredScopeFor("PUT", "/api/activities/:code")).toBe("write:activity");
    expect(requiredScopeFor("DELETE", "/api/activities/:code/groups/:group")).toBe(
      "write:activity",
    );
    expect(requiredScopeFor("GET", "/api/reports")).toBe("read:reports");
    expect(requiredScopeFor("PUT", "/api/settings")).toBe("write:settings");
  });

  it("没登记的端点回落到 read / write（fail-closed：细粒度 token 访问不了新端点）", () => {
    expect(requiredScopeFor("GET", "/api/brand-new")).toBe("read");
    expect(requiredScopeFor("POST", "/api/brand-new")).toBe("write");
    // 方法也算判定的一部分：对同一个路径换方法就换了要求
    expect(requiredScopeFor("POST", "/api/reports")).toBe("write");
  });

  it("server.ts 里每个受保护的端点都在登记表里（防止新端点忘了声明）", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/adminApi/server.ts", import.meta.url)),
      "utf8",
    );
    const declared = new Set(
      ADMIN_API_ROUTE_SCOPES.map((rule) => `${rule.method} ${rule.url}`),
    );
    const publicRoutes = new Set([
      "GET /healthz",
      "POST /auth/token",
      "GET /auth/me",
      "POST /auth/logout",
    ]);
    const found = [
      ...source.matchAll(/app\.(get|post|put|delete)\("([^"]+)"/gu),
    ].map((match) => `${match[1]!.toUpperCase()} ${match[2]!}`);
    expect(found.length).toBeGreaterThan(30);
    const missing = found.filter(
      (route) => !declared.has(route) && !publicRoutes.has(route),
    );
    expect(missing).toEqual([]);
  });

  it("scope 清单：通配 + 每个域都有一份读 scope，可写的域才有写 scope", () => {
    expect(ADMIN_API_KNOWN_SCOPES).toContain("*");
    expect(ADMIN_API_KNOWN_SCOPES).toContain("read");
    expect(ADMIN_API_KNOWN_SCOPES).toContain("write");
    expect(ADMIN_API_KNOWN_SCOPES).toContain("read:join");
    expect(ADMIN_API_KNOWN_SCOPES).toContain("write:activity");
    expect(ADMIN_API_KNOWN_SCOPES).toContain("read:reports");
    // 只读域没有写 scope
    expect(ADMIN_API_KNOWN_SCOPES).not.toContain("write:reports");
    expect(ADMIN_API_KNOWN_SCOPES).not.toContain("write:audit");
    // 部署（回滚）是平台级写域（ADR-0065）
    expect(ADMIN_API_KNOWN_SCOPES).toContain("read:deploy");
    expect(ADMIN_API_KNOWN_SCOPES).toContain("write:deploy");
    expect(requiredScopeFor("POST", "/api/deploy/rollback")).toBe("write:deploy");
    const deploy = ADMIN_API_SCOPE_DOMAINS.find((meta) => meta.domain === "deploy");
    expect(deploy?.platformOnly).toBe(true);
  });
});

describe("machineTokenAllows", () => {
  it("通配：* 全放，read / write 只放自己那一族", () => {
    expect(machineTokenAllows(token(["*"]), "read:join")).toBe(true);
    expect(machineTokenAllows(token(["*"]), "write:punish")).toBe(true);
    expect(machineTokenAllows(token(["read"]), "read:audit")).toBe(true);
    expect(machineTokenAllows(token(["read"]), "write:activity")).toBe(false);
    expect(machineTokenAllows(token(["write"]), "write:activity")).toBe(true);
    expect(machineTokenAllows(token(["write"]), "read:pending")).toBe(false);
  });

  it("细粒度：精确匹配才算，前缀相同也不算", () => {
    const join = token(["read:join"]);
    expect(machineTokenAllows(join, "read:join")).toBe(true);
    expect(machineTokenAllows(join, "write:join")).toBe(false);
    expect(machineTokenAllows(join, "read:audit")).toBe(false);
    expect(machineTokenAllows(token(["write:activity"]), "write:activity")).toBe(true);
    expect(machineTokenAllows(token(["write:activity"]), "read:activity")).toBe(false);
  });

  it("过期即不可用（不管 scope 多宽）", () => {
    const past = new Date(Date.now() - 60_000);
    expect(machineTokenAllows(token(["*"], past), "read:join")).toBe(false);
    const future = new Date(Date.now() + 60_000);
    expect(machineTokenAllows(token(["*"], future), "read:join")).toBe(true);
  });
});

describe("parseMachineTokens：scope 里带冒号 + 到期时间两种写法", () => {
  it("细粒度 scope 不会被当成到期时间切开", () => {
    const { tokens, issues } = parseMachineTokens(
      "abcdef0123456789:read:join|write:activity",
    );
    expect(issues).toEqual([]);
    expect(tokens[0]?.scopes).toEqual(["read:join", "write:activity"]);
    expect(tokens[0]?.expiresAt).toBeUndefined();
  });

  it("新写法用 @ 给到期时间（scope 里可以有冒号）", () => {
    const { tokens, issues } = parseMachineTokens(
      "abcdef0123456789:read:audit|write:notify@2027-01-01T00:00:00Z",
    );
    expect(issues).toEqual([]);
    expect(tokens[0]?.scopes).toEqual(["read:audit", "write:notify"]);
    expect(tokens[0]?.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("旧写法 `token:read:2027-…` 仍然认（第二个冒号后面是合法时间才当到期）", () => {
    const { tokens, issues } = parseMachineTokens(
      "abcdef0123456789:read:2027-01-01T00:00:00Z",
    );
    expect(issues).toEqual([]);
    expect(tokens[0]?.scopes).toEqual(["read"]);
    expect(tokens[0]?.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("多个令牌用逗号分隔，各自 scope 独立", () => {
    const { tokens, issues } = parseMachineTokens(
      "abcdef0123456789:read,abcdef9876543210:write:activity@2027-01-01T00:00:00Z",
    );
    expect(issues).toEqual([]);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]?.scopes).toEqual(["write:activity"]);
  });

  it("未知 scope / 太短 / 没 scope：都如实报错（fail-closed）", () => {
    const unknown = parseMachineTokens("abcdef0123456789:read:nope");
    expect(unknown.tokens).toEqual([]);
    expect(unknown.issues[0]).toContain("未知 scope");
    expect(unknown.issues[0]).toContain("read:join");

    const short = parseMachineTokens("short:read");
    expect(short.issues[0]).toContain("太短");

    const empty = parseMachineTokens("abcdef0123456789:");
    expect(empty.issues[0]).toContain("缺少 scope");
  });

  it("配置坏了就启动失败（loadAdminApiConfig 抛错，而不是带半套凭据跑）", () => {
    expect(() =>
      loadAdminApiConfig({
        ADMIN_API_ENABLED: "true",
        ADMIN_API_SESSION_SECRET: "m".repeat(40),
        ADMIN_API_TOKENS: "abcdef0123456789:read:nope",
      }),
    ).toThrow(/管理 API 配置有问题/u);

    const ok = loadAdminApiConfig({
      ADMIN_API_ENABLED: "true",
      ADMIN_API_SESSION_SECRET: "m".repeat(40),
      ADMIN_API_TOKENS: "abcdef0123456789:read:join",
    });
    expect(ok.machineTokens[0]?.scopes).toEqual(["read:join"]);
  });
});
