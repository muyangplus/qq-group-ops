import { describe, expect, it } from "vitest";

import { AuditStatus } from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import { AuditLogStore } from "../src/services/audit.js";

describe("AuditLogStore", () => {
  it("appends and finds records by group", () => {
    const log = new AuditLogStore();
    const record = {
      recordId: "1",
      groupId: "g1",
      actorId: "admin",
      action: "approve_join_request",
      status: AuditStatus.Approved,
      reason: "",
      createdAt: utcNow(),
    };

    log.append(record);

    expect(log.findByGroup("g1")).toEqual([record]);
    expect(log.findByGroup("g2")).toEqual([]);
    expect(log.all()).toEqual([record]);
  });
});
