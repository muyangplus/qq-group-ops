import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { FakeEventGateway } from "../src/adapters/fakeEventGateway.js";
import { loadSettings } from "../src/config.js";
import { attachGateway } from "../src/gatewayRunner.js";
import { MemberRoster } from "../src/services/memberRoster.js";
import { createRuntime } from "../src/runtime.js";
import { FakeIdentityBindingRepository } from "./helpers/fakeIdentityBindingRepository.js";

describe("createRuntime", () => {
  it("falls back to fake mode without credentials", () => {
    const runtime = createRuntime(loadSettings({}));
    expect(runtime.mode).toBe("fake");
    expect(runtime.api).toBeDefined();
    expect(runtime.groupMessageMode.get("g1")).toBe("unknown");
    expect(runtime.identityMap.listUsers()).toEqual([]);
  });

  it("wires join request routing", async () => {
    const runtime = createRuntime(loadSettings({}));
    const result = await runtime.router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });
    expect(result.ok).toBe(true);
    expect(runtime.joinAudit.pending("g1")).toHaveLength(1);
  });

  it("wires admin commands with configured admins", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "admin" }));
    runtime.identityMap.bindUser("admin", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    runtime.joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await runtime.router.handle({
      type: "admin_command",
      groupId: "g1",
      userId: "admin",
      text: "/pending",
    });
    expect(result.kind).toBe("command");
    expect(result.ok).toBe(true);
    // 申请只显示短码；未绑定申请人也显示短码，不再暴露内部 id
    expect(result.text).toMatch(/#[0-9A-Za-z]{6}/u);
    expect(result.text).not.toContain("r1");
    expect(result.text).not.toContain("u1");
  });

  it("forwards rich message options through the instrumentation proxy", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "admin" }));
    runtime.identityMap.bindUser("admin", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    runtime.notifications.subscribe("admin", "g1");

    await runtime.router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });

    const api = runtime.api as unknown as FakeQQOfficialAPI;
    expect(api.sentPrivateMessages[0]?.markdown).toContain("新的入群申请");
    expect(api.sentPrivateMessages[0]?.keyboard).toBeDefined();
  });

  it("forwards blacklist options through the instrumentation proxy", async () => {
    const runtime = createRuntime(loadSettings({}));
    const api = runtime.api as unknown as FakeQQOfficialAPI;

    await runtime.api.removeGroupMember("g1", "u1", {
      addToMemberBlacklist: true,
    });
    await runtime.api.updateMemberBlacklist("g1", "u1", true);

    expect(api.blacklistOperations).toEqual([
      ["g1", "u1", "add"],
      ["g1", "u1", "add"],
    ]);
  });

  it("loads persisted bindings into the identity map", async () => {
    const repository = new FakeIdentityBindingRepository();
    await repository.bind("user", "admin", "10001");
    await repository.bind("group", "g1", "654321");

    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "admin" }), {
      repositories: { identityBindings: repository },
    });
    await runtime.identityMap.reload();

    expect(runtime.identityMap.persistent).toBe(true);
    expect(runtime.identityMap.getQq("admin")).toBe("10001");
    expect(runtime.identityMap.getGroupNumber("g1")).toBe("654321");
  });

  it("persists bindings made through the router and restores them after restart", async () => {
    const repository = new FakeIdentityBindingRepository();
    const first = createRuntime(loadSettings({}), {
      repositories: { identityBindings: repository },
    });

    const bind = await first.router.handle({
      type: "private_message",
      userId: "u1",
      messageId: "m1",
      content: "/bind qq 123456",
    });
    expect(bind.ok).toBe(true);
    expect(repository.bindings).toEqual([
      { kind: "user", officialId: "u1", externalId: "123456" },
    ]);

    const restarted = createRuntime(loadSettings({}), {
      repositories: { identityBindings: repository },
    });
    await restarted.identityMap.reload();
    const query = await restarted.router.handle({
      type: "private_message",
      userId: "u1",
      messageId: "m2",
      content: "/myperm",
    });
    expect(query.ok).toBe(true);
  });

  it("routes the §C rules callbacks through the interaction handler", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "admin" }));
    runtime.identityMap.bindUser("admin", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as unknown as FakeQQOfficialAPI;

    // 先设一个字段级覆盖，再点「恢复本页继承」回调
    runtime.configStore.setOverride({ groupId: "g1", wordFilterEnabled: false });
    const reset = await runtime.router.handle({
      type: "interaction",
      interactionId: "i1",
      interactionType: 11,
      groupId: "g1",
      userId: "admin",
      buttonData:
        "cb:rules:resetPage:g1:toggle:wordFilterEnabled,keywordRecall,joinAuditEnabled,exportEnabled:1:allow",
    });
    expect(reset.ok).toBe(true);
    expect(runtime.configStore.get("g1").wordFilterEnabled).toBe(true);
    expect(String(api.sentMessages.at(-1)?.markdown ?? "")).toContain(
      "已恢复本页继承",
    );

    // 普通成员点管理类回调 → 返回「权限不足」卡（不静默）
    const denied = await runtime.router.handle({
      type: "interaction",
      interactionId: "i2",
      interactionType: 11,
      groupId: "g1",
      userId: "member",
      buttonData: "cb:rules:resetAll:g1:1",
    });
    expect(denied.ok).toBe(true);
    expect(String(api.sentMessages.at(-1)?.markdown ?? "")).toContain("权限不足");
  });

  /**
   * §B4 端到端：群里手输 `/activity join` → 群内静默、结果私信。
   *
   * 覆盖 `AdminCommandService` → `EventRouter`（透传 `silent`）→ `gatewayRunner`
   * （`silent === true` 时跳过一次 `sendReply`）的整条链路。
   */
  it("keeps the group silent for /activity join and DMs the result (§B4)", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "admin" }));
    const api = runtime.api as unknown as FakeQQOfficialAPI;
    runtime.identityMap.bindUser("admin", "10001");
    runtime.identityMap.bindUser("member", "10002");
    runtime.identityMap.bindGroup("g1", "654321");
    // 个人资料写入需要班级库（学院由班级库自动带出）
    runtime.userProfiles.setRoster(
      MemberRoster.fromIndex({
        classes: ["材化2211"],
        majors: ["材料化学"],
        classInfo: {
          材化2211: {
            major: "材料化学",
            college: "化学与生命科学学院",
            year: "2022",
          },
        },
      }),
    );
    runtime.userProfiles.set("member", "name", "小明");
    runtime.userProfiles.set("member", "studentId", "22123456789");
    runtime.userProfiles.set("member", "className", "材化2211");

    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    // 建活动 + 开放报名（管理员操作，正常有群回复）
    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "admin",
      messageId: "m1",
      content: "/activity create 迎新晚会",
    });
    const created = runtime.activity.listActivities("g1")[0]!;
    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "admin",
      messageId: "m2",
      content: `/activity open #${created.code}`,
    });

    const groupMessagesBeforeJoin = api.sentMessages.length;
    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "member",
      messageId: "m3",
      content: `/activity join #${created.code}`,
    });

    // 群内一条都不发；结果私信给本人
    expect(api.sentMessages).toHaveLength(groupMessagesBeforeJoin);
    const dm = String(api.sentPrivateMessages.at(-1)?.markdown ?? "");
    expect(dm).toContain("报名成功");
    expect(dm).toContain("小明");

    // 私聊里同样的指令仍然原地回复（首次私信还会额外推一次主菜单）
    const privateMessagesBeforeJoin = api.sentPrivateMessages.length;
    await gateway.emit({
      type: "private_message",
      userId: "member",
      messageId: "m4",
      content: `/activity quit #${created.code}`,
    });
    const privateText = api.sentPrivateMessages
      .slice(privateMessagesBeforeJoin)
      .map((item) => String(item.markdown ?? ""))
      .join("\n");
    expect(privateText).toContain("已取消报名");
  });
});
