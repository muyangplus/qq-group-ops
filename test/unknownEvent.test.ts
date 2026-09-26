import { describe, expect, it } from "vitest";

import { QQOfficialEventMapper } from "../src/adapters/qqOfficialEventMapper.js";

/**
 * 未知事件类型：每次记 warn（由 logger 负责），**每种类型只通知一次**装配方（超管私信）。
 */
describe("QQOfficialEventMapper · 未知事件类型", () => {
  it("每种类型只回调一次，并带上原始 payload", () => {
    const seen: Array<{ eventType: string; payload: unknown }> = [];
    const mapper = new QQOfficialEventMapper({
      onUnhandledEvent: (info) => {
        seen.push(info);
      },
    });
    const payload = { group_openid: "g1", op_member_openid: "u1" };

    expect(mapper.map("GROUP_ADD_ROBOT", payload)).toBeNull();
    expect(mapper.map("GROUP_ADD_ROBOT", payload)).toBeNull();
    expect(mapper.map("C2C_FRIEND_ADD", { user_openid: "u1" })).toBeNull();

    expect(seen.map((item) => item.eventType)).toEqual([
      "GROUP_ADD_ROBOT",
      "C2C_FRIEND_ADD",
    ]);
    expect(seen[0]?.payload).toEqual(payload);
  });

  it("没有装配回调时也不抛错（纯记日志）", () => {
    const mapper = new QQOfficialEventMapper();
    expect(mapper.map("GROUP_ADD_ROBOT", {})).toBeNull();
  });
});
