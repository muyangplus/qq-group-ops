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
    await api.approveJoinRequest("g1", "u1", true, {
      joinRequestId: "r1",
    });
    expect(api.joinRequestReviews).toEqual([
      { groupId: "g1", memberOpenid: "u1", op: "approve", joinRequestId: "r1" },
    ]);
  });

  it("records group image uploads and sends", async () => {
    const api = new FakeQQOfficialAPI();
    const png = Uint8Array.from([137, 80, 78, 71]);

    const uploaded = await api.uploadGroupImage("g1", "activity-ACT001.png", png);
    const fileInfo = String(uploaded.file_info);
    expect(fileInfo.length).toBeGreaterThan(0);
    expect(api.uploadedGroupImages).toEqual([["g1", "activity-ACT001.png", png]]);

    const sent = await api.sendGroupImage("g1", fileInfo);
    expect(sent).toHaveProperty("id");
    expect(api.sentGroupImages).toEqual([["g1", fileInfo, undefined]]);
  });

  it("records the passive msg_id when sending a group image", async () => {
    const api = new FakeQQOfficialAPI();
    await api.sendGroupImage("g1", "info-1", "m1");
    expect(api.sentGroupImages).toEqual([["g1", "info-1", "m1"]]);
  });

  it("fails group image upload and send when the switch is on", async () => {
    const api = new FakeQQOfficialAPI();
    api.failGroupImages = true;
    await expect(
      api.uploadGroupImage("g1", "x.png", Uint8Array.from([1])),
    ).rejects.toThrow("group image upload failure");
    await expect(api.sendGroupImage("g1", "info-1")).rejects.toThrow(
      "group image send failure",
    );
    expect(api.uploadedGroupImages).toEqual([]);
    expect(api.sentGroupImages).toEqual([]);
  });
});
