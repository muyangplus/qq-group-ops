import { describe, expect, it } from "vitest";

import { describePermissions } from "../src/adminApi/permissions.js";
import { PermissionService } from "../src/services/permissions.js";
import { loadAdminApiConfig } from "../src/adminApi/config.js";
import { buildAdminApiServer } from "../src/adminApi/server.js";
import type { AdminTokenRepository } from "../src/db/adminTokenRepository.js";

/**
 * 权限画像（E2-d）：与机器人共用两轴模型，前端据此隐藏入口（服务端仍强校验）。
 */

const CONFIG = loadAdminApiConfig({
  ADMIN_API_ENABLED: "true",
  ADMIN_API_SESSION_SECRET: "p".repeat(40),
});

function memoryTokens(): AdminTokenRepository {
  let issued = 0;
  return {
    async issue({ now }) {
      issued += 1;
      return {
        token: `tok-${issued}`,
        expiresAt: new Date((now?.getTime() ?? Date.now()) + 60_000),
      };
    },
    async redeem(token) {
      return token === "tok-1" ? "op1" : undefined;
    },
    async pruneExpired() {},
    async countActive() {
      return 0;
    },
  };
}

describe("describePermissions", () => {
  it("平台超管：平台档 240，群内档按折算生效", () => {
    const permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
    });

    const view = describePermissions(permissions, "root", ["g1", "g2"]);

    expect(view.platformLevel).toBe(240);
    // 平台 240 折算成群内 140（本群超管）
    expect(view.groups).toEqual([
      { groupId: "g1", level: 140 },
      { groupId: "g2", level: 140 },
    ]);
  });

  it("群管理员：平台档 0，只有自己那个群有权", () => {
    const permissions = new PermissionService({
      groupAdminIds: new Map([["g1", ["admin"]]]),
    });

    const view = describePermissions(permissions, "admin", ["g1", "g2"]);

    expect(view.platformLevel).toBe(0);
    expect(view.groups).toEqual([{ groupId: "g1", level: 130 }]);
  });

  it("普通成员：没有任何权限", () => {
    const permissions = new PermissionService({
      groupAdminIds: new Map([["g1", ["admin"]]]),
    });

    expect(describePermissions(permissions, "member", ["g1"])).toEqual({
      platformLevel: 0,
      groups: [],
    });
  });
});

describe("/auth/me 附带权限画像", () => {
  it("装配 permissionsOf 时返回 platformLevel 与 groups", async () => {
    const tokens = memoryTokens();
    const app = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      permissionsOf: async (userId: string) => ({
        platformLevel: userId === "op1" ? 240 : 0,
        groups: [{ groupId: "g1", level: 130 }],
      }),
    }).app;

    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const cookie = login.headers["set-cookie"];
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        cookie: String(Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0] ?? "",
      },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      userId: "op1",
      permissions: { platformLevel: 240, groups: [{ groupId: "g1", level: 130 }] },
    });

    await app.close();
  });
});
