import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AuditLogStore } from "../src/services/audit.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";

describe("JoinRequestSyncService", () => {
  let api: FakeQQOfficialAPI;
  let joinAudit: JoinAuditService;
  let service: JoinRequestSyncService;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    joinAudit = new JoinAuditService(new AuditLogStore());
    service = new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 });
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

  it("parses official join request fields", async () => {
    api.joinRequests.set("official", {
      group_id: "g1",
      join_request_id: "r9",
      member_openid: "m9",
      verify_info: { verify_message: "我想加入" },
    });

    const pending = await service.syncGroup("g1");

    expect(pending).toEqual([
      expect.objectContaining({
        requestId: "r9",
        userId: "m9",
        reason: "我想加入",
      }),
    ]);
  });

  it("throttles repeated syncs of the same group", async () => {
    let now = 1_000;
    const throttled = new JoinRequestSyncService(api, joinAudit, {
      minIntervalMs: 30_000,
      clock: () => now,
    });

    await throttled.syncGroup("g1");
    await expect(throttled.syncGroup("g1")).rejects.toThrow(/过于频繁/u);
    expect(throttled.cooldownMs("g1")).toBe(30_000);

    now += 30_000;
    expect(throttled.cooldownMs("g1")).toBe(0);
    await expect(throttled.syncGroup("g1")).resolves.toEqual([]);
  });
});
