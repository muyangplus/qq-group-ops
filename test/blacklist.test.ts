import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AuditLogStore } from "../src/services/audit.js";
import { BlacklistService } from "../src/services/blacklist.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";

/**
 * §A5 黑名单：本群 / 全局作用域、踢人、官方群拉黑接口、入群审批最高优先级拦截。
 */
describe("BlacklistService", () => {
  it("adds a group entry, kicks and calls the official group blacklist API", async () => {
    const api = new FakeQQOfficialAPI();
    const auditLog = new AuditLogStore();
    const blacklist = new BlacklistService(api, {
      auditLog,
      listBoundGroups: () => ["g1", "g2"],
    });

    const result = await blacklist.add({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
      reason: "广告",
    });

    expect(result.ok).toBe(true);
    expect(result.kicked).toEqual(["g1"]);
    expect(result.officialOk).toBe(true);
    expect(api.removedMembers).toEqual([["g1", "u1"]]);
    expect(api.blacklistOperations).toEqual([["g1", "u1", "add"]]);
    expect(blacklist.has("g1", "u1")).toBe(true);
    // 本群黑名单不影响其他群
    expect(blacklist.has("g2", "u1")).toBe(false);
    expect(auditLog.all().at(-1)?.action).toBe("blacklist:add:group");
  });

  it("global entries kick from every bound group and skip the group-level official API", async () => {
    const api = new FakeQQOfficialAPI();
    const blacklist = new BlacklistService(api, {
      listBoundGroups: () => ["g1", "g2", "g2"],
    });

    const result = await blacklist.add({
      scope: "global",
      userId: "u1",
      actorId: "root",
      reason: "全站骚扰",
    });

    expect(result.kicked).toEqual(["g1", "g2"]);
    expect(api.blacklistOperations).toEqual([]);
    expect(blacklist.hasGlobal("u1")).toBe(true);
    expect(blacklist.has("g1", "u1")).toBe(true);
    expect(blacklist.has("g2", "u1")).toBe(true);
    expect(blacklist.globalEntries()).toHaveLength(1);
  });

  it("remove deletes locally and unblocks the official group blacklist", async () => {
    const api = new FakeQQOfficialAPI();
    const blacklist = new BlacklistService(api, { listBoundGroups: () => ["g1"] });
    await blacklist.add({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
    });

    const removed = await blacklist.remove("group", "g1", "u1");

    expect(removed).toBe(true);
    expect(blacklist.has("g1", "u1")).toBe(false);
    expect(api.blacklistOperations).toEqual([
      ["g1", "u1", "add"],
      ["g1", "u1", "del"],
    ]);
    expect(await blacklist.remove("group", "g1", "u1")).toBe(false);
  });

  it("join approval rejects a blacklisted applicant before any join rule", async () => {
    const api = new FakeQQOfficialAPI();
    const blacklist = new BlacklistService(api, { listBoundGroups: () => ["g1"] });
    const joinAudit = new JoinAuditService();
    // 群配置是「自动通过」，但黑名单必须优先于一切规则
    const configStore = new GroupConfigStore({
      groupId: "__default__",
      enabled: true,
      joinAuditEnabled: true,
      autoApproveJoin: true,
    });
    const approval = new JoinApprovalService(
      api,
      joinAudit,
      configStore,
      undefined,
      blacklist,
    );
    joinAudit.submit("g1", "u1", "想加入", "r1");
    await blacklist.add({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
    });

    const outcome = await approval.applyJoinRules("g1", "r1");

    expect(outcome.action).toBe("reject");
    expect(api.joinRequestReviews.at(-1)).toMatchObject({
      groupId: "g1",
      memberOpenid: "u1",
      op: "decline",
      joinRequestId: "r1",
    });
    expect(joinAudit.get("r1").status).toBe("rejected");
  });

  it("keeps manual review when the official reject fails", async () => {
    const api = new FakeQQOfficialAPI();
    api.failJoinRequestApprovals = true;
    const blacklist = new BlacklistService(api, { listBoundGroups: () => ["g1"] });
    const joinAudit = new JoinAuditService();
    const configStore = new GroupConfigStore({ groupId: "__default__" });
    const approval = new JoinApprovalService(
      api,
      joinAudit,
      configStore,
      undefined,
      blacklist,
    );
    joinAudit.submit("g1", "u1", "想加入", "r1");
    await blacklist.add({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
    });

    const outcome = await approval.applyJoinRules("g1", "r1");

    expect(outcome.action).toBe("manual");
    expect(joinAudit.get("r1").status).toBe("pending");
  });
});
