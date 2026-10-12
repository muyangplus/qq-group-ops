import { describe, expect, it, vi } from "vitest";

import { FakeEventGateway } from "../src/adapters/fakeEventGateway.js";
import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { loadSettings } from "../src/config.js";
import { attachGateway } from "../src/gatewayRunner.js";
import { createRuntime } from "../src/runtime.js";

describe("FakeEventGateway", () => {
  it("dispatches events after start", async () => {
    const gateway = new FakeEventGateway();
    const received: string[] = [];
    await gateway.start((event) => {
      received.push(event.type);
    });

    await gateway.emit({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
    });

    expect(received).toEqual(["join_request"]);
    expect(gateway.isRunning).toBe(true);
  });

  it("rejects events after stop", async () => {
    const gateway = new FakeEventGateway();
    await gateway.start(() => undefined);
    await gateway.stop();

    await expect(
      gateway.emit({
        type: "join_request",
        groupId: "g1",
        userId: "u1",
        requestId: "r1",
      }),
    ).rejects.toThrow(/not running/u);
  });

  it("attaches to the runtime and routes events", async () => {
    const runtime = createRuntime(loadSettings({}));
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });

    expect(runtime.joinAudit.pending("g1")).toHaveLength(1);
  });

  it("sends command replies back to the group", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "mod" }));
    runtime.identityMap.bindUser("mod", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m1",
      content: "/test",
    });

    expect(api.sentMessages).toHaveLength(1);
    // /test 现在是卡片：正文在 markdown 里（纯文本降级在 text）
    expect(
      String(api.sentMessages[0]?.markdown ?? api.sentMessages[0]?.content),
    ).toContain("测试成功");
    expect(api.sentMessages[0]?.msgId).toBe("m1");
    // §F1：test 模块豁免，群里不自动 @
    expect(String(api.sentMessages[0]?.markdown ?? "")).not.toMatch(/^<@!/u);
  });

  it("mentions the group initiator on command replies", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "mod" }));
    runtime.identityMap.bindUser("mod", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m1",
      content: "/menu",
    });

    expect(api.sentMessages).toHaveLength(1);
    // §F1：群内回复首行 @ 发起人（卡片 markdown 里的提及真机有效）
    expect(String(api.sentMessages[0]?.markdown ?? "")).toMatch(/^## 常用菜单\n<@!mod>$/u);
    expect(String(api.sentMessages[0]?.markdown ?? "")).toContain("常用菜单");
  });

  it("sends private command replies", async () => {
    const runtime = createRuntime(loadSettings({}));
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "private_message",
      userId: "u1",
      messageId: "m1",
      content: "/bind qq 123456",
    });

    // 只回指令那一条：**不再额外叠一张主菜单**（一条消息最多一张卡，2026-10-12 修复）
    expect(api.sentPrivateMessages).toHaveLength(1);
    const reply = api.sentPrivateMessages[0];
    // /bind 现在是卡片：正文在 markdown 里
    expect(
      String(reply?.markdown ?? reply?.content),
    ).toContain("已绑定");
    expect(reply?.msgId).toBe("m1");
    // §F1：只在群内 @，私聊不加
    expect(String(reply?.markdown ?? "")).not.toMatch(/^<@!/u);

    // 「首次私信」标记**没有被消耗**：下一条普通消息才把常用菜单补给他
    await gateway.emit({
      type: "private_message",
      userId: "u1",
      messageId: "m2",
      content: "你好",
    });
    expect(api.sentPrivateMessages).toHaveLength(2);
    const menu = api.sentPrivateMessages[1];
    expect(menu?.msgId).toBeUndefined();
    expect(String(menu?.markdown ?? menu?.content)).toContain("常用菜单");
  });

  it("pushes the main menu only on the first non-command private interaction", async () => {
    const runtime = createRuntime(loadSettings({}));
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    // 指令：回指令、不补菜单，也不消耗「首次」
    await gateway.emit({
      type: "private_message",
      userId: "u1",
      messageId: "m1",
      content: "/bind qq 123456",
    });
    // 普通消息：这才推一次常用菜单
    await gateway.emit({
      type: "private_message",
      userId: "u1",
      messageId: "m2",
      content: "你好",
    });
    // 之后的普通消息：不再打扰
    await gateway.emit({
      type: "private_message",
      userId: "u1",
      messageId: "m3",
      content: "在吗",
    });

    // 2 条回复 = /bind 的指令回复 + 一次主菜单（之后那条什么都没有）
    expect(api.sentPrivateMessages).toHaveLength(2);
    const menus = api.sentPrivateMessages.filter((message) =>
      String(message.markdown ?? "").includes("常用菜单"),
    );
    expect(menus).toHaveLength(1);
    expect(menus[0]?.msgId).toBeUndefined();
  });

  it("returns the main menu for an empty group mention", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "mod" }));
    runtime.identityMap.bindUser("mod", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m1",
      content: "",
      mentioned: true,
    });

    // 空 @机器人 → 主菜单卡片，走被动回复
    expect(api.sentMessages).toHaveLength(1);
    expect(String(api.sentMessages[0]?.markdown ?? "")).toContain("常用菜单");
    expect(api.sentMessages[0]?.msgId).toBe("m1");
    // §F1：空 @机器人 也属于「群内回复」，首行 @ 发起人
    expect(String(api.sentMessages[0]?.markdown ?? "")).toMatch(/^## 常用菜单\n<@!mod>$/u);
  });

  /**
   * 2026-10-12 真机反馈：全量消息模式下**一次发 N 张图片 → 机器人 @N 次**。
   *
   * 根因：图片 / 文件 / 语音的正文是空的，被当成「空 @机器人」回了 N 张常用菜单卡。
   * 现在只有**真的 @ 了机器人**（`mentioned`）才会回菜单。
   */
  it("does not reply to empty group messages that do not mention the bot", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "mod" }));
    runtime.identityMap.bindUser("mod", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    // 连发 3 张图片（正文都是空、都没有 @ 机器人）
    for (const messageId of ["m1", "m2", "m3"]) {
      await gateway.emit({
        type: "group_message",
        groupId: "g1",
        userId: "member",
        messageId,
        content: "",
      });
    }

    // 一条都不回：既不刷菜单卡，也不 @ 人
    expect(api.sentMessages).toHaveLength(0);
  });

  it("does not fail the event when a reply cannot be sent", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "mod" }));
    runtime.identityMap.bindUser("mod", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as FakeQQOfficialAPI;
    vi.spyOn(api, "sendGroupMessage").mockRejectedValue(
      new Error("passive reply quota exhausted"),
    );
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await expect(
      gateway.emit({
        type: "group_message",
        groupId: "g1",
        userId: "mod",
        messageId: "m1",
        content: "/test",
      }),
    ).resolves.toBeUndefined();
  });
});
