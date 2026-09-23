import { describe, expect, it } from "vitest";

import { DisplayNameService } from "../src/services/displayNames.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { ShortCodeService } from "../src/services/shortCodes.js";

async function createDisplay(): Promise<{
  display: DisplayNameService;
  identityMap: IdentityMapService;
  shortCodes: ShortCodeService;
}> {
  const identityMap = new IdentityMapService();
  const shortCodes = new ShortCodeService();
  const display = new DisplayNameService(identityMap, shortCodes);
  return { display, identityMap, shortCodes };
}

describe("DisplayNameService", () => {
  it("shows the bound QQ number or group number", async () => {
    const { display, identityMap } = await createDisplay();
    await identityMap.bindUser("user-openid", "123456");
    await identityMap.bindGroup("group-openid", "654321");

    expect(display.user("user-openid")).toBe("123456");
    expect(display.group("group-openid")).toBe("654321");
  });

  it("shows a short code instead of the internal id when unbound", async () => {
    const { display } = await createDisplay();

    const userLabel = display.user("user-openid");
    const groupLabel = display.group("group-openid");
    const requestLabel = display.request("very-long-join-request-id");

    expect(userLabel).toMatch(/^#[0-9A-Za-z]{6}$/u);
    expect(groupLabel).toMatch(/^#[0-9A-Za-z]{6}$/u);
    expect(requestLabel).toMatch(/^#[0-9A-Za-z]{6}$/u);
    // 稳定：同一 id 反复展示得到同一个短码
    expect(display.user("user-openid")).toBe(userLabel);
    expect(display.request("very-long-join-request-id")).toBe(requestLabel);
  });

  it("resolves short codes back to internal ids", async () => {
    const { display } = await createDisplay();
    const userLabel = display.user("user-openid");
    const groupLabel = display.group("group-openid");
    const requestLabel = display.request("request-id");

    expect(display.resolveUser(userLabel)).toBe("user-openid");
    expect(display.resolveGroup(groupLabel)).toBe("group-openid");
    expect(display.resolveRequest(requestLabel)).toBe("request-id");
    // 类型必须匹配
    expect(display.resolveUser(groupLabel)).toBeUndefined();
    expect(display.resolveGroup(userLabel)).toBeUndefined();
    expect(display.isShortCode(userLabel)).toBe(true);
    expect(display.isShortCode("123456")).toBe(false);
  });

  it("keeps accepting the full join_request_id for compatibility", async () => {
    const { display } = await createDisplay();
    expect(display.resolveRequest("ARvtM_tE85a2U1EG8z_B3YPEx6EcEIIJ")).toBe(
      "ARvtM_tE85a2U1EG8z_B3YPEx6EcEIIJ",
    );
    expect(display.resolveRequest("")).toBeUndefined();
  });
});
