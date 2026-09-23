import { describe, expect, it } from "vitest";

import { QQOfficialEventMapper } from "../src/adapters/qqOfficialEventMapper.js";

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
