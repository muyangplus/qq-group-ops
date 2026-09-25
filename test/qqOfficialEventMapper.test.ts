import { describe, expect, it } from "vitest";

import {
  QQOfficialEventMapper,
  stripBotMention,
} from "../src/adapters/qqOfficialEventMapper.js";

describe("QQOfficialEventMapper", () => {
  const mapper = new QQOfficialEventMapper();

  it("maps group at-messages", () => {
    expect(
      mapper.map("GROUP_AT_MESSAGE_CREATE", {
        id: "m1",
        group_openid: "g1",
        content: "hello",
        author: { member_openid: "u1" },
      }),
    ).toEqual({
      type: "group_message",
      groupId: "g1",
      userId: "u1",
      messageId: "m1",
      content: "hello",
    });
  });

  it("maps full group messages", () => {
    expect(
      mapper.map("GROUP_MESSAGE_CREATE", {
        id: "m1",
        group_openid: "g1",
        content: "hello",
        author: { id: "u1" },
      }),
    ).toEqual({
      type: "group_message",
      groupId: "g1",
      userId: "u1",
      messageId: "m1",
      content: "hello",
    });
  });

  it("strips the leading bot mention from @ messages", () => {
    expect(
      mapper.map("GROUP_AT_MESSAGE_CREATE", {
        id: "m1",
        group_openid: "g1",
        content: "<@!123456> /menu",
        author: { member_openid: "u1" },
      }),
    ).toMatchObject({ content: "/menu" });

    // 只有 @机器人、没有内容：映射成空内容，router 会返回主菜单
    expect(
      mapper.map("GROUP_AT_MESSAGE_CREATE", {
        id: "m2",
        group_openid: "g1",
        content: "<@!123456>",
        author: { member_openid: "u1" },
      }),
    ).toMatchObject({ content: "" });
  });

  it("only strips leading mentions", () => {
    expect(stripBotMention("大家好 <@!123456>")).toBe("大家好 <@!123456>");
    expect(stripBotMention("  <@!1> <@!2> /menu")).toBe("/menu");
    expect(stripBotMention("/menu")).toBe("/menu");
  });

  it("strips every mention shape the client may send", () => {
    // 常见：机器人 appid
    expect(stripBotMention("<@!1234567890> /menu")).toBe("/menu");
    expect(stripBotMention("<@1234567890>/menu")).toBe("/menu");
    // 非数字 id 与全角叹号
    expect(stripBotMention("<@!abc-def> /menu")).toBe("/menu");
    expect(stripBotMention("<@！123> /menu")).toBe("/menu");
    // 昵称形式，以及客户端插入的零宽/双向控制字符
    expect(stripBotMention("@机器人 /menu")).toBe("/menu");
    expect(stripBotMention("\u2068@机器人\u2069 /menu")).toBe("/menu");
    expect(stripBotMention("<@!123>\u200B/menu")).toBe("/menu");
    // 只有提及没有内容 → 空内容（router 会回主菜单）
    expect(stripBotMention("<@!1234567890>")).toBe("");
    expect(stripBotMention("@机器人")).toBe("");
    expect(stripBotMention("\u2068@机器人\u2069")).toBe("");
  });

  it("leaves normal chat that addresses other people alone", () => {
    expect(stripBotMention("@张三 你好")).toBe("@张三 你好");
    expect(stripBotMention("大家好 @张三")).toBe("大家好 @张三");
  });

  it("maps button interaction events", () => {
    expect(
      mapper.map("INTERACTION_CREATE", {
        application_id: "123456789",
        chat_type: 1,
        data: {
          resolved: { button_data: "testmenu:page:2", button_id: "next" },
          type: 11,
        },
        group_member_openid: "u1",
        group_openid: "g1",
        id: "06915133-7aef-46ed-94f7-c50939e285ae",
        scene: "group",
        timestamp: "2026-07-20T21:53:54+08:00",
        type: 11,
        version: 1,
      }),
    ).toEqual({
      type: "interaction",
      interactionId: "06915133-7aef-46ed-94f7-c50939e285ae",
      interactionType: 11,
      scene: "group",
      chatType: 1,
      groupId: "g1",
      userId: "u1",
      buttonId: "next",
      buttonData: "testmenu:page:2",
    });

    // 单聊场景：只有 user_openid
    expect(
      mapper.map("INTERACTION_CREATE", {
        chat_type: 2,
        data: {
          resolved: { button_data: "confirm:once", button_id: "allow-once" },
          type: 11,
        },
        id: "1b13d569-4610-4ab9-bc51-feecc5def6d4",
        scene: "c2c",
        type: 11,
        user_openid: "u2",
      }),
    ).toMatchObject({
      scene: "c2c",
      userId: "u2",
      buttonData: "confirm:once",
    });
  });

  it("ignores interaction events without an id", () => {
    expect(mapper.map("INTERACTION_CREATE", { type: 11 })).toBeNull();
  });

  it("maps join requests", () => {
    expect(
      mapper.map("GROUP_JOIN_REQUEST", {
        group_openid: "g1",
        member_openid: "u1",
        join_request_id: "r1",
        verify_info: { verify_message: "想加入" },
      }),
    ).toEqual({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });
  });

  it("maps the answer of admin_review_qa join requests", () => {
    expect(
      mapper.map("GROUP_JOIN_REQUEST", {
        group_openid: "g1",
        join_request_id: "r1",
        member_openid: "u1",
        username: "小明",
        apply_source: "self_apply",
        verify_info: {
          method: "admin_review_qa",
          review_qa_list: [
            { question: "请回答班级+姓名", answer: "环工2214 小明" },
          ],
        },
      }),
    ).toEqual({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "环工2214 小明",
      applicantName: "小明",
      verifyMethod: "admin_review_qa",
      applySource: "self_apply",
      questions: ["请回答班级+姓名"],
    });
  });

  it("keeps invited join requests without an answer", () => {
    expect(
      mapper.map("GROUP_JOIN_REQUEST", {
        group_openid: "g1",
        join_request_id: "r1",
        member_openid: "u1",
        username: "小红",
        apply_source: "invited",
        invited_by: "u2",
      }),
    ).toEqual({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      applicantName: "小红",
      applySource: "invited",
    });
  });

  it("joins multiple answers and ignores blank ones", () => {
    const event = mapper.map("GROUP_JOIN_REQUEST", {
      group_openid: "g1",
      join_request_id: "r1",
      member_openid: "u1",
      verify_info: {
        method: "admin_review_qa",
        review_qa_list: [
          { question: "Q1", answer: "环工2214" },
          { question: "Q2", answer: "   " },
        ],
      },
    });
    expect(event).toMatchObject({ reason: "环工2214" });
  });

  it("maps private messages", () => {
    expect(
      mapper.map("C2C_MESSAGE_CREATE", {
        id: "m1",
        content: "/bind qq 123456",
        author: { user_openid: "u1" },
      }),
    ).toEqual({
      type: "private_message",
      userId: "u1",
      messageId: "m1",
      content: "/bind qq 123456",
    });
  });

  it("rejects invalid payloads", () => {
    expect(mapper.map("UNKNOWN", {})).toBeNull();
    expect(mapper.map("GROUP_AT_MESSAGE_CREATE", {})).toBeNull();
  });
});
