import { describe, expect, it } from "vitest";

import { PermissionLevel } from "../src/core/enums.js";
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
    expect(service.levelFor("root", "g1")).toBe(PermissionLevel.SuperAdmin);
    expect(service.canExportData("root", "g1")).toBe(true);
  });

  it("scopes group admins to their group", () => {
    expect(service.levelFor("ga1", "g1")).toBe(PermissionLevel.GroupAdmin);
    expect(service.levelFor("ga1", "g2")).toBe(PermissionLevel.Member);
    expect(service.canApproveJoin("ga1", "g1")).toBe(true);
    expect(service.canApproveJoin("ga1", "g2")).toBe(false);
  });

  it("allows moderators to review but not approve", () => {
    expect(service.canReviewContent("mod1", "g1")).toBe(true);
    expect(service.canApproveJoin("mod1", "g1")).toBe(false);
  });

  it("denies management to members", () => {
    expect(service.canManageRules("member", "g1")).toBe(false);
    expect(service.canExportData("member", "g1")).toBe(false);
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
    expect(mutable.canApproveJoin("u1", "g1")).toBe(true);
    expect(mutable.canReviewContent("u2", "g1")).toBe(true);
    expect(mutable.listGroupAdmins("g1")).toEqual(["u1"]);
    expect(mutable.listModerators("g1")).toEqual(["u2"]);

    mutable.revokeGroupAdmin("g1", "u1");
    mutable.revokeModerator("g1", "u2");
    expect(mutable.canApproveJoin("u1", "g1")).toBe(false);
    expect(mutable.canReviewContent("u2", "g1")).toBe(false);
  });
});
