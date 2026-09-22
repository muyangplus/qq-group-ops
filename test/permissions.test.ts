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
});
