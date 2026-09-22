import { describe, expect, it, beforeEach } from "vitest";

import { AuditStatus } from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import type { Activity, ActivityRegistration } from "../src/services/activity.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { ExportService, maskIdentifier } from "../src/services/export.js";
import { PermissionService } from "../src/services/permissions.js";

describe("ExportService", () => {
  let auditLog: InMemoryAuditLog;
  let service: ExportService;
  let activity: Activity;
  let registrations: ActivityRegistration[];

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
    const permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
    });
    service = new ExportService(permissions, auditLog);
    activity = {
      activityId: "a1",
      groupId: "g1",
      title: "周末活动",
      createdBy: "admin",
      description: "",
      status: "draft",
      createdAt: utcNow(),
    };
    registrations = [
      {
        registrationId: "r1",
        activityId: "a1",
        groupId: "g1",
        userId: "user1",
        displayName: "小明",
        note: "",
        createdAt: utcNow(),
      },
    ];
  });

  it("masks identifiers", () => {
    expect(maskIdentifier("user1")).toBe("u***1");
    expect(maskIdentifier("ab")).toBe("**");
    expect(maskIdentifier(undefined)).toBe("");
  });

  it("requires export permission", () => {
    expect(() =>
      service.exportActivityRegistrationsCsv("member", activity, registrations),
    ).toThrow(/permission denied/u);
  });

  it("exports activity registrations with masked user ids", () => {
    const content = service.exportActivityRegistrationsCsv(
      "admin",
      activity,
      registrations,
    );
    const rows = content.trim().split("\n").map((line) => line.split(","));
    expect(rows[0]?.[0]).toBe("registration_id");
    expect(rows[1]?.[0]).toBe("r1");
    expect(rows[1]?.[3]).toBe("u***1");
    expect(auditLog.all()[0]?.action).toBe("export_activity_registrations");
    expect(auditLog.all()[0]?.status).toBe(AuditStatus.Executed);
  });

  it("exports audit records", () => {
    const records = [
      {
        recordId: "rec1",
        groupId: "g1",
        actorId: "admin",
        targetUserId: "user1",
        action: "approve_join_request",
        status: AuditStatus.Approved,
        reason: "ok",
        createdAt: utcNow(),
      },
    ];
    const content = service.exportAuditRecordsCsv("root", "g1", records);
    const rows = content.trim().split("\n").map((line) => line.split(","));
    expect(rows[0]?.[0]).toBe("record_id");
    expect(rows[1]?.[0]).toBe("rec1");
    expect(rows[1]?.[2]).toBe("a***n");
    expect(rows[1]?.[3]).toBe("u***1");
  });
});
