import { describe, expect, it } from "vitest";

import { IdentityMapService } from "../src/services/identityMap.js";

describe("IdentityMapService", () => {
  it("binds and resolves users", () => {
    const map = new IdentityMapService();
    map.bindUser("openid-user", "123456");
    expect(map.resolveUserId("openid-user")).toBe("openid-user");
    expect(map.resolveUserId("123456")).toBe("openid-user");
    expect(map.getQq("openid-user")).toBe("123456");
    expect(map.listUsers()).toEqual([{ officialId: "openid-user", qq: "123456" }]);
  });

  it("binds and resolves groups", () => {
    const map = new IdentityMapService();
    map.bindGroup("openid-group", "654321");
    expect(map.resolveGroupId("openid-group")).toBe("openid-group");
    expect(map.resolveGroupId("654321")).toBe("openid-group");
    expect(map.getGroupNumber("openid-group")).toBe("654321");
    expect(map.listGroups()).toEqual([
      { officialId: "openid-group", groupNumber: "654321" },
    ]);
  });

  it("returns undefined for unknown values", () => {
    const map = new IdentityMapService();
    expect(map.resolveUserId("unknown")).toBeUndefined();
    expect(map.resolveGroupId("unknown")).toBeUndefined();
  });
});
