import { describe, expect, it } from "vitest";

import { IdentityMapService } from "../src/services/identityMap.js";
import { FakeIdentityBindingRepository } from "./helpers/fakeIdentityBindingRepository.js";

describe("IdentityMapService", () => {
  it("binds and resolves users", () => {
    const map = new IdentityMapService();
    void map.bindUser("openid-user", "123456");
    expect(map.resolveUserId("openid-user")).toBe("openid-user");
    expect(map.resolveUserId("123456")).toBe("openid-user");
    expect(map.getQq("openid-user")).toBe("123456");
    expect(map.listUsers()).toEqual([{ officialId: "openid-user", qq: "123456" }]);
  });

  it("binds and resolves groups", () => {
    const map = new IdentityMapService();
    void map.bindGroup("openid-group", "654321");
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

  it("rebinds an official id and releases the previous external id", () => {
    const map = new IdentityMapService();
    void map.bindUser("openid-user", "123456");
    void map.bindUser("openid-user", "999999");
    expect(map.getQq("openid-user")).toBe("999999");
    expect(map.resolveUserId("123456")).toBeUndefined();
    expect(map.resolveUserId("999999")).toBe("openid-user");
  });

  it("reassigns an external id that was bound to another official id", () => {
    const map = new IdentityMapService();
    void map.bindUser("first-user", "123456");
    void map.bindUser("second-user", "123456");
    expect(map.getQq("first-user")).toBeUndefined();
    expect(map.resolveUserId("123456")).toBe("second-user");
  });

  it("writes bindings through to the repository", async () => {
    const repository = new FakeIdentityBindingRepository();
    const map = new IdentityMapService(repository);

    await map.bindUser("openid-user", "123456");
    await map.bindGroup("openid-group", "654321");

    expect(map.persistent).toBe(true);
    expect(repository.bindCalls).toEqual([
      { kind: "user", officialId: "openid-user", externalId: "123456" },
      { kind: "group", officialId: "openid-group", externalId: "654321" },
    ]);
  });

  it("loads persisted bindings on reload", async () => {
    const repository = new FakeIdentityBindingRepository();
    repository.bindings.push(
      { kind: "user", officialId: "openid-user", externalId: "123456" },
      { kind: "group", officialId: "openid-group", externalId: "654321" },
    );
    const map = new IdentityMapService(repository);

    await map.reload();

    expect(map.getQq("openid-user")).toBe("123456");
    expect(map.getGroupNumber("openid-group")).toBe("654321");
    expect(map.resolveUserId("123456")).toBe("openid-user");
    expect(map.resolveGroupId("654321")).toBe("openid-group");
  });

  it("replaces stale in-memory bindings when reloading", async () => {
    const repository = new FakeIdentityBindingRepository();
    const map = new IdentityMapService(repository);
    await map.bindUser("stale-user", "111111");
    repository.bindings.length = 0;
    repository.bindings.push({
      kind: "user",
      officialId: "fresh-user",
      externalId: "222222",
    });

    await map.reload();

    expect(map.getQq("stale-user")).toBeUndefined();
    expect(map.getQq("fresh-user")).toBe("222222");
  });

  it("rolls back the memory cache when persistence fails", async () => {
    const repository = new FakeIdentityBindingRepository();
    const map = new IdentityMapService(repository);
    await map.bindUser("openid-user", "123456");
    repository.failNextBind = true;

    await expect(map.bindUser("openid-user", "999999")).rejects.toThrow(
      /database unavailable/u,
    );

    expect(map.getQq("openid-user")).toBe("123456");
    expect(map.resolveUserId("999999")).toBeUndefined();
  });

  it("stays memory-only without a repository", async () => {
    const map = new IdentityMapService();
    expect(map.persistent).toBe(false);
    await expect(map.reload()).resolves.toBeUndefined();
    await map.bindUser("openid-user", "123456");
    expect(map.getQq("openid-user")).toBe("123456");
  });
});
