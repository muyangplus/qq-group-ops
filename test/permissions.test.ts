import { describe, expect, it } from "vitest";

import { PermissionLevel, PlatformLevel } from "../src/core/enums.js";
import {
  PermissionDeniedError,
  PermissionService,
} from "../src/services/permissions.js";

describe("PermissionService", () => {
  const service = new PermissionService({
    superAdminIds: new Set(["root"]),
    groupAdminIds: new Map([["g1", new Set(["ga1"])]]),
    moderatorIds: new Map([["g1", new Set(["mod1"])]]),
  });

  it("treats super admin as highest", () => {
    // 全局超管 240 → 群内折算 140（本群超管档）；平台档单独看 globalLevelOf
    expect(service.levelFor("root", "g1")).toBe(PermissionLevel.SuperAdmin);
    expect(service.globalLevelOf("root")).toBe(240);
    expect(service.meetsGlobal("root", PlatformLevel.GlobalSuperAdmin)).toBe(true);
    expect(
      service.meetsInGroup("root", "g1", PermissionLevel.GroupAdmin),
    ).toBe(true);
  });

  it("scopes group admins to their group", () => {
    expect(service.levelFor("ga1", "g1")).toBe(PermissionLevel.GroupAdmin);
    expect(service.levelFor("ga1", "g2")).toBe(PermissionLevel.Member);
    expect(
      service.meetsInGroup("ga1", "g1", PermissionLevel.GroupAdmin),
    ).toBe(true);
    expect(
      service.meetsInGroup("ga1", "g2", PermissionLevel.GroupAdmin),
    ).toBe(false);
  });

  it("allows moderators to review but not approve", () => {
    expect(
      service.meetsInGroup("mod1", "g1", PermissionLevel.Moderator),
    ).toBe(true);
    expect(
      service.meetsInGroup("mod1", "g1", PermissionLevel.GroupAdmin),
    ).toBe(false);
  });

  it("lists only groups where the user can approve join requests", () => {
    expect(service.listReviewableGroups("ga1")).toEqual(["g1"]);
    expect(service.listReviewableGroups("mod1")).toEqual([]);
    expect(service.listReviewableGroups("member")).toEqual([]);
    // 全局超管对任何群都能审批，但只会列出已授权过的群
    expect(service.listReviewableGroups("root")).toEqual(["g1"]);
  });

  it("lists only groups where the user can review content", () => {
    expect(service.listModeratedGroups("mod1")).toEqual(["g1"]);
    expect(service.listModeratedGroups("ga1")).toEqual(["g1"]);
    expect(service.listModeratedGroups("member")).toEqual([]);
  });

  it("denies management to members", () => {
    expect(
      service.meetsInGroup("member", "g1", PermissionLevel.GroupAdmin),
    ).toBe(false);
    expect(
      service.meetsInGroup("member", "g1", PermissionLevel.Moderator),
    ).toBe(false);
  });

  it("answers 'in any group' only for groups where the user has the role", () => {
    expect(service.meetsAnywhere("mod1", PermissionLevel.Moderator)).toBe(true);
    // 群管理员在群内档位上覆盖审核员
    expect(service.meetsAnywhere("ga1", PermissionLevel.Moderator)).toBe(true);
    expect(service.meetsAnywhere("mod1", PermissionLevel.GroupAdmin)).toBe(
      false,
    );
    expect(service.meetsAnywhere("outsider", PermissionLevel.Moderator)).toBe(
      false,
    );
    // 全局超管在群内折算 140，因此「任意群的最高档」也成立
    expect(service.meetsAnywhere("root", PermissionLevel.SuperAdmin)).toBe(
      true,
    );
  });

  it("treats private context as guest", () => {
    expect(service.levelFor("member", undefined)).toBe(PermissionLevel.Guest);
  });

  it("throws on ensure(false)", () => {
    expect(() => service.ensure(false, "no permission")).toThrow(
      PermissionDeniedError,
    );
  });

  it("grants and revokes super admins", () => {
    const mutable = new PermissionService({
      superAdminIds: new Set(["root"]),
    });
    mutable.grantSuperAdmin("u1");
    expect(mutable.isSuperAdmin("u1")).toBe(true);
    expect(mutable.listSuperAdmins()).toEqual(["root", "u1"]);

    mutable.revokeSuperAdmin("u1");
    expect(mutable.isSuperAdmin("u1")).toBe(false);
    expect(() => mutable.revokeSuperAdmin("root")).toThrow(
      /last super admin/u,
    );
  });

  it("grants and revokes group roles", () => {
    const mutable = new PermissionService();
    mutable.grantGroupAdmin("g1", "u1");
    mutable.grantModerator("g1", "u2");
    expect(
      mutable.meetsInGroup("u1", "g1", PermissionLevel.GroupAdmin),
    ).toBe(true);
    expect(
      mutable.meetsInGroup("u2", "g1", PermissionLevel.Moderator),
    ).toBe(true);
    expect(mutable.listGroupAdmins("g1")).toEqual(["u1"]);
    expect(mutable.listModerators("g1")).toEqual(["u2"]);

    mutable.revokeGroupAdmin("g1", "u1");
    mutable.revokeModerator("g1", "u2");
    expect(
      mutable.meetsInGroup("u1", "g1", PermissionLevel.GroupAdmin),
    ).toBe(false);
    expect(
      mutable.meetsInGroup("u2", "g1", PermissionLevel.Moderator),
    ).toBe(false);
  });

  it("scopes group super admins to their own group only", () => {
    const mutable = new PermissionService({
      groupSuperAdminIds: new Map([["g1", new Set(["owner1"])]]),
    });

    // 本群内是最高权限
    expect(mutable.levelFor("owner1", "g1")).toBe(PermissionLevel.SuperAdmin);
    expect(
      mutable.meetsInGroup("owner1", "g1", PermissionLevel.GroupAdmin),
    ).toBe(true);
    expect(mutable.isGroupSuperAdmin("owner1", "g1")).toBe(true);

    // 其他群、私信、平台级判断都不受影响
    expect(mutable.levelFor("owner1", "g2")).toBe(PermissionLevel.Member);
    expect(mutable.levelFor("owner1", undefined)).toBe(PermissionLevel.Guest);
    expect(mutable.isGroupSuperAdmin("owner1", "g2")).toBe(false);
    expect(mutable.isSuperAdmin("owner1")).toBe(false);
  });

  it("grants and revokes group super admins", () => {
    const mutable = new PermissionService();

    mutable.grantGroupSuperAdmin("g1", "u1");
    expect(mutable.isGroupSuperAdmin("u1", "g1")).toBe(true);
    expect(mutable.listGroupSuperAdmins("g1")).toEqual(["u1"]);
    expect(mutable.meetsAnywhere("u1", PermissionLevel.GroupAdmin)).toBe(true);

    mutable.revokeGroupSuperAdmin("g1", "u1");
    expect(mutable.isGroupSuperAdmin("u1", "g1")).toBe(false);
    expect(mutable.levelFor("u1", "g1")).toBe(PermissionLevel.Member);
  });
});
