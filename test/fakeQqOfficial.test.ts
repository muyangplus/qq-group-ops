import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";

describe("FakeQQOfficialAPI", () => {
  it("sends group messages", async () => {
    const api = new FakeQQOfficialAPI();
    const result = await api.sendGroupMessage("g1", "hello", "m1");
    expect(result).toHaveProperty("id");
    expect(api.sentMessages[0]?.groupId).toBe("g1");
    expect(api.sentMessages[0]?.content).toBe("hello");
    expect(api.sentMessages[0]?.msgId).toBe("m1");
  });

  it("sends private messages", async () => {
    const api = new FakeQQOfficialAPI();
    const result = await api.sendPrivateMessage("u1", "hello", "m1");
    expect(result).toHaveProperty("id");
    expect(api.sentPrivateMessages[0]?.userOpenid).toBe("u1");
    expect(api.sentPrivateMessages[0]?.content).toBe("hello");
    expect(api.sentPrivateMessages[0]?.msgId).toBe("m1");
  });

  it("recalls and mutes", async () => {
    const api = new FakeQQOfficialAPI();
    await api.recallGroupMessage("g1", "m1");
    await api.muteGroupMember("g1", "u1", 600);
    expect(api.recalledMessages).toEqual([["g1", "m1"]]);
    expect(api.mutedMembers).toEqual([["g1", "u1", 600]]);
  });

  it("handles join request flow", async () => {
    const api = new FakeQQOfficialAPI();
    api.addJoinRequest("g1", "u1", "想加入", "r1");
    const requests = await api.getJoinRequests("g1");
    expect(requests[0]?.request_id).toBe("r1");
    await api.approveJoinRequest("g1", "u1", true, "ok");
    expect(api.joinRequestReviews).toEqual([["g1", "u1", true, "ok"]]);
  });
});
