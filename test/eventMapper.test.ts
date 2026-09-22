import { describe, expect, it } from "vitest";

import { JsonEventMapper } from "../src/adapters/eventMapper.js";

describe("JsonEventMapper", () => {
  const mapper = new JsonEventMapper();

  it("maps group messages", () => {
    expect(
      mapper.map({
        type: "group_message",
        groupId: "g1",
        userId: "u1",
        messageId: "m1",
        content: "广告",
      }),
    ).toEqual({
      type: "group_message",
      groupId: "g1",
      userId: "u1",
      messageId: "m1",
      content: "广告",
    });
  });

  it("maps join requests", () => {
    expect(
      mapper.map({
        type: "join_request",
        groupId: "g1",
        userId: "u1",
        requestId: "r1",
        reason: "想加入",
      }),
    ).toEqual({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });
  });

  it("maps admin commands", () => {
    expect(
      mapper.map({
        type: "admin_command",
        groupId: "g1",
        userId: "admin",
        text: "/pending",
      }),
    ).toEqual({
      type: "admin_command",
      groupId: "g1",
      userId: "admin",
      text: "/pending",
    });
  });

  it("rejects invalid payloads", () => {
    expect(mapper.map(null)).toBeNull();
    expect(mapper.map({ type: "unknown" })).toBeNull();
    expect(mapper.map({ type: "group_message", groupId: "g1" })).toBeNull();
  });
});
