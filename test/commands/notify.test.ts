import {
  NOTIFY_CHANNELS,
  NOTIFY_SCOPE_ALL,
} from "../../src/services/notifications.js";
import { describe, expect, it } from "vitest";
import { api, notifications, service } from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · **统一通知订阅菜单**（重构后唯一入口）。
 *
 * 老的 `/notify on|off|all|<群>`、`/notify punish …`、`/activity subscribe` 已删除，
 * 订阅只通过菜单卡的回调完成（`cb:notify:set:<频道>:<范围>:<on|off>`）。
 */
describe("AdminCommandService · notify", () => {
  it("opens one menu covering all three channels", async () => {
    const result = await service.handle("g1", "admin", "/notify");

    expect(result.ok).toBe(true);
    expect(result.rich.markdown).toContain("**入群申请**");
    expect(result.rich.markdown).toContain("**处罚与申诉**");
    expect(result.rich.markdown).toContain("**活动通知**");

    // 群内：每个频道一行「本群 / 全部 / 测试」
    const keyboard = JSON.stringify(result.rich.keyboard);
    expect(keyboard).toContain("cb:notify:set:join:g1:on");
    expect(keyboard).toContain("cb:notify:set:punish:g1:on");
    expect(keyboard).toContain("cb:notify:set:activity:g1:on");
    expect(keyboard).toContain(`cb:notify:set:join:${NOTIFY_SCOPE_ALL}:on`);
    expect(keyboard).toContain("cb:notify:test:activity");
  });

  it("subscribes and unsubscribes a channel for the current group", async () => {
    const on = await service.notifyToggleCard("join", "g1", true, "admin", "g1");

    expect(on.ok).toBe(true);
    expect(on.rich.markdown).toContain("已开启：入群申请 · 群 654321");
    expect(on.rich.markdown).toContain("<@!admin>");
    expect(on.rich.markdown).not.toContain("操作人：");
    expect(notifications.isSubscribed("admin", "g1", "join")).toBe(true);

    const off = await service.notifyToggleCard("join", "g1", false, "admin", "g1");
    expect(off.ok).toBe(true);
    expect(off.rich.markdown).toContain("已关闭：入群申请 · 群 654321");
    expect(notifications.isSubscribed("admin", "g1", "join")).toBe(false);
  });

  it("subscribes every channel for all groups", async () => {
    for (const channel of NOTIFY_CHANNELS) {
      const result = await service.notifyToggleCard(
        channel,
        NOTIFY_SCOPE_ALL,
        true,
        "root",
      );
      expect(result.ok, channel).toBe(true);
      expect(
        notifications.isSubscribed("root", NOTIFY_SCOPE_ALL, channel),
        channel,
      ).toBe(true);
    }
  });

  it("keeps the per-channel permission gates", async () => {
    // 审核员能订阅处罚与申诉，但订阅不了入群申请
    const punish = await service.notifyToggleCard("punish", "g1", true, "mod", "g1");
    expect(punish.ok).toBe(true);
    expect(notifications.isSubscribed("mod", "g1", "punish")).toBe(true);

    const join = await service.notifyToggleCard("join", "g1", true, "mod", "g1");
    expect(join.ok).toBe(false);
    expect(join.rich.markdown).toContain("权限不足");
    expect(notifications.isSubscribed("mod", "g1", "join")).toBe(false);

    // 活动通知不限权限（普通成员也能订本群）
    const activity = await service.notifyToggleCard(
      "activity",
      "g1",
      true,
      "member",
      "g1",
    );
    expect(activity.ok).toBe(true);
    expect(notifications.isSubscribed("member", "g1", "activity")).toBe(true);
  });

  it("requires a bound QQ number for the activity「全部群」subscription", async () => {
    // `stranger` 没有绑定 QQ 号 → 订不了「全部群」（绑定是全局的）
    const denied = await service.notifyToggleCard(
      "activity",
      NOTIFY_SCOPE_ALL,
      true,
      "stranger",
    );
    expect(denied.ok).toBe(false);
    expect(denied.rich.markdown).toContain("绑定");

    const allowed = await service.notifyToggleCard(
      "activity",
      NOTIFY_SCOPE_ALL,
      true,
      "admin",
    );
    expect(allowed.ok).toBe(true);
    expect(notifications.isSubscribed("admin", NOTIFY_SCOPE_ALL, "activity")).toBe(
      true,
    );
  });

  it("sends a per-channel test card", async () => {
    const result = await service.notifyTestCard("activity", "admin", "g1", "g1");

    expect(result.ok).toBe(true);
    expect(api.sentPrivateMessages[0]?.userOpenid).toBe("admin");
    expect(api.sentPrivateMessages[0]?.markdown).toContain("活动通知测试");

    // `/notify test <频道>` 走同一个自检入口
    const join = await service.handle("g1", "admin", "/notify test join");
    expect(join.ok).toBe(true);
    expect(api.sentPrivateMessages.at(-1)?.markdown).toContain("推送测试");
  });

  it("通知中心分页：超管看到全部 8 个话题", async () => {
    const first = await service.handle("g1", "root", "/notify");
    expect(first.rich.markdown).toContain("通知中心（1/2）");
    expect(first.rich.markdown).toContain("**入群申请**");
    expect(first.rich.markdown).toContain("**机器人入群**");
    expect(first.rich.markdown).not.toContain("**未定义事件**");
    const keyboard = JSON.stringify(first.rich.keyboard);
    expect(keyboard).toContain("cb:notify:view:2");

    const second = service.notifyCard(undefined, "root", undefined, 2);
    expect(second.rich.markdown).toContain("通知中心（2/2）");
    expect(second.rich.markdown).toContain("**机器人退群**");
    expect(second.rich.markdown).toContain("**未定义事件**");
    expect(JSON.stringify(second.rich.keyboard)).toContain("cb:notify:view:1");
  });

  it("超管专属话题不对普通群管理员显示", async () => {
    const result = await service.handle("g1", "admin", "/notify");

    expect(result.rich.markdown).toContain("通知中心（1/1）");
    expect(result.rich.markdown).not.toContain("机器人入群");
    expect(result.rich.markdown).not.toContain("未定义事件");
    const keyboard = JSON.stringify(result.rich.keyboard);
    expect(keyboard).toContain("cb:notify:set:join:g1:on");
    expect(keyboard).toContain("cb:notify:test:activity");
  });

  it("推送卡上的「取消订阅此通知」：立刻退订并给「重新订阅」防误点", async () => {
    await service.notifyToggleCard("join", "g1", true, "admin", "g1");
    expect(notifications.isSubscribed("admin", "g1", "join")).toBe(true);

    const card = service.notifyUnsubscribeCard("join", "g1", "admin", "g1");
    expect(card.ok).toBe(true);
    expect(card.rich.markdown).toContain("已取消：入群申请 · 群 654321");
    expect(notifications.isSubscribed("admin", "g1", "join")).toBe(false);
    expect(JSON.stringify(card.rich.keyboard)).toContain(
      "cb:notify:set:join:g1:on",
    );

    const again = service.notifyUnsubscribeCard("join", "g1", "admin", "g1");
    expect(again.rich.markdown).toContain("本来就是关闭的");
  });

  it("话题门槛子卡：只有全局超管能看 / 改，改完立即生效", async () => {
    const denied = await service.handle("g1", "admin", "/notify level");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("只有全局超管");

    const card = await service.handle("g1", "root", "/notify level");
    expect(card.ok).toBe(true);
    expect(card.rich.markdown).toContain("话题门槛");
    expect(card.rich.markdown).toContain("入群申请");
    expect(card.rich.markdown).toContain("不限"); // 活动通知默认 -1
    const keyboard = JSON.stringify(card.rich.keyboard);
    expect(keyboard).toContain("/notify level join");
    expect(keyboard).toContain("cb:notify:levelReset");

    const changed = await service.handle("g1", "root", "/notify level join 240");
    expect(changed.ok, changed.text).toBe(true);
    expect(notifications.topicLevel("join")).toBe(240);
    expect(changed.rich.markdown).toContain("已把「入群申请」的门槛改为");
    // 门槛立刻生效：群管理员不再满足入群推送的资格
    expect(notifications.checkTopicReach("admin", "join", "g1").ok).toBe(false);

    const bad = await service.handle("g1", "root", "/notify level join 999");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("门槛必须");

    const restored = service.notifyResetLevelsCard("root");
    expect(restored.ok).toBe(true);
    expect(notifications.topicLevel("join")).toBe(130);
  });

  it("通知中心：超管能看到「门槛」入口，普通管理员看不到", async () => {
    const root = await service.handle("g1", "root", "/notify");
    expect(JSON.stringify(root.rich.keyboard)).toContain("cb:notify:level");

    const admin = await service.handle("g1", "admin", "/notify");
    expect(JSON.stringify(admin.rich.keyboard)).not.toContain("cb:notify:level");
  });
});
