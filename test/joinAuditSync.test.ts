import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";

describe("JoinRequestSyncService", () => {
  let api: FakeQQOfficialAPI;
  let joinAudit: JoinAuditService;
  let service: JoinRequestSyncService;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    joinAudit = new JoinAuditService(new InMemoryAuditLog());
    service = new JoinRequestSyncService(api, joinAudit);
  });

  it("imports pending requests", async () => {
    api.addJoinRequest("g1", "u1", "想加入", "r1");
    api.addJoinRequest("g1", "u2", "活动报名", "r2");
    api.addJoinRequest("g2", "u3", "其他群", "r3");

    const pending = await service.syncGroup("g1");

    expect(pending.map((request) => request.requestId)).toEqual(["r1", "r2"]);
  });

  it("is idempotent", async () => {
    api.addJoinRequest("g1", "u1", "想加入", "r1");
    await service.syncGroup("g1");
    await service.syncGroup("g1");
    expect(joinAudit.pending("g1")).toHaveLength(1);
  });

  it("skips invalid entries", async () => {
    api.joinRequests.set("bad", { request_id: "bad", group_id: "g1" });
    expect(await service.syncGroup("g1")).toEqual([]);
  });
});
