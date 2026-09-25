import { NOTIFY_SCOPE_ALL } from "../../src/services/notifications.js";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  api,
  notifications,
  service,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · notify（5 个用例）。
 */

describe("AdminCommandService · notify", () => {
  it("subscribes and unsubscribes join request push from a group", async () => {
    const on = await service.handle("g1", "admin", "/notify on");
    expect(on.ok).toBe(true);
    expect(on.text).toContain("已开启");
    expect(notifications.isSubscribed("admin", "g1")).toBe(true);

    const status = await service.handle("g1", "admin", "/notify");
    // 群号已绑定 → 只显示群号
    expect(status.text).toContain("当前群：已开启（654321）");
    expect(status.text).not.toContain("（g1）");

    const off = await service.handle("g1", "admin", "/notify off");
    expect(off.text).toContain("已关闭");
    expect(notifications.isSubscribed("admin", "g1")).toBe(false);
  });

  it("treats /notify on in private as all reviewable groups", async () => {
    const result = await service.handle(undefined, "admin", "/notify on");
    expect(result.ok).toBe(true);
    expect(notifications.isSubscribed("admin", NOTIFY_SCOPE_ALL)).toBe(true);
  });

  it("lists the push subscription status without leaking other groups", async () => {
    await service.handle("g1", "admin", "/notify on");
    const result = await service.handle(undefined, "admin", "/notify");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("可审批的群：654321");
    expect(result.text).not.toContain("（g1）");
  });

  it("toggles push subscriptions by callback with operator feedback", async () => {
    const on = await service.notifyToggleCard("g1", true, "admin", "g1");

    expect(on.ok).toBe(true);
    expect(notifications.isSubscribed("admin", "g1")).toBe(true);
    // 回调自动完成必须有反馈，并在开头单独一行 @ 操作人
    expect(on.rich.markdown).toContain("结果");
    expect(on.rich.markdown).toContain("<@!admin>");
    expect(on.rich.markdown).not.toContain("操作人：");

    const off = await service.notifyToggleCard("g1", false, "admin");
    expect(off.ok).toBe(true);
    expect(notifications.isSubscribed("admin", "g1")).toBe(false);
  });

  it("sends a push test card", async () => {
    await service.handle("g1", "admin", "/notify on");
    const result = await service.handle("g1", "admin", "/notify test");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已发送推送测试卡片");
    expect(api.sentPrivateMessages[0]?.userOpenid).toBe("admin");
    expect(api.sentPrivateMessages[0]?.markdown).toContain("推送测试");
  });
});
