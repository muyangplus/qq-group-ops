import { describe, expect, it } from "vitest";

import {
  QQOfficialEventMapper,
  REPEATING_EVENT_TYPES,
} from "../src/adapters/qqOfficialEventMapper.js";
import { topicOfOfficialEvent } from "../src/services/notifyTopics.js";

/**
 * 未处理事件类型：每次记 warn（由 logger 负责），回调装配方（话题订阅）——
 * **变动类事件每次都回调**（否则「机器人被移出群」这种只第一次通知得到），
 * 其余未知类型每类型只回调一次（避免一个平台 bug 刷私信）。
 */
describe("QQOfficialEventMapper · 未知事件类型", () => {
  it("变动类事件每次都回调，并带上原始 payload", () => {
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
    expect(mapper.map("C2C_FRIEND_ADD", { user_openid: "u2" })).toBeNull();

    expect(seen.map((item) => item.eventType)).toEqual([
      "GROUP_ADD_ROBOT",
      "GROUP_ADD_ROBOT",
      "C2C_FRIEND_ADD",
      "C2C_FRIEND_ADD",
    ]);
    expect(seen[0]?.payload).toEqual(payload);
    for (const type of ["GROUP_ADD_ROBOT", "C2C_FRIEND_ADD"]) {
      expect(REPEATING_EVENT_TYPES.has(type), type).toBe(true);
    }
  });

  it("真正未知的类型仍然每种只回调一次", () => {
    const seen: string[] = [];
    const mapper = new QQOfficialEventMapper({
      onUnhandledEvent: (info) => {
        seen.push(info.eventType);
      },
    });

    expect(mapper.map("SOME_PLATFORM_BUG", { a: 1 })).toBeNull();
    expect(mapper.map("SOME_PLATFORM_BUG", { a: 2 })).toBeNull();

    expect(seen).toEqual(["SOME_PLATFORM_BUG"]);
    expect(topicOfOfficialEvent("SOME_PLATFORM_BUG")).toBe("unknown_event");
    expect(topicOfOfficialEvent("GROUP_ADD_ROBOT")).toBe("bot_join");
    expect(topicOfOfficialEvent("GROUP_DEL_ROBOT")).toBe("bot_leave");
    expect(topicOfOfficialEvent("GROUP_MEMBER_ADD")).toBe("member_join");
    expect(topicOfOfficialEvent("C2C_FRIEND_ADD")).toBe("friend");
  });

  it("没有装配回调时也不抛错（纯记日志）", () => {
    const mapper = new QQOfficialEventMapper();
    expect(mapper.map("GROUP_ADD_ROBOT", {})).toBeNull();
  });
});
