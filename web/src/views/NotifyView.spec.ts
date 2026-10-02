import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch, type StubbedCall } from "@/test/fetch";
import NotifyView from "@/views/NotifyView.vue";

/**
 * 通知页（P2 第二批）的组件测试：门槛表 + 非超管的只读口径。
 *
 * 这批用例的意义在于**真的渲染一遍**：以前只有扫源码的契约守卫，
 * 「服务端回 `{ topics }`、前端当数组用」这种 bug 能一路漏到线上。
 */
function signIn(platformLevel: number): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: "boss",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { platformLevel, groups: [] },
  };
}

const TOPIC = {
  topic: "join",
  label: "入群申请",
  hint: "有新的入群申请时推给能审批的人",
  defaultLevel: 130,
  level: 130,
  allScope: 2,
  groupScopes: 5,
};

describe("NotifyView", () => {
  it("渲染服务端话题表（回归：响应是 { topics }，以前当数组用永远是空表）", async () => {
    signIn(240);
    const fetch = stubFetch(() => ({ body: { topics: [TOPIC] } }));

    const wrapper = mount(NotifyView);
    await flushPromises();

    expect(wrapper.find("table").exists()).toBe(true);
    expect(wrapper.text()).toContain("入群申请");
    // 门槛用人话显示（与机器人 `/notify level` 同一套文案）
    expect(wrapper.text()).toContain("130（群管理员）");
    expect(wrapper.text()).toContain("全部群 2 人");
    expect(wrapper.text()).not.toContain("没有可展示的话题");
    // 超管才有「改门槛」
    expect(wrapper.text()).toContain("改门槛");
    fetch.restore();
  });

  it("非超管：看得到门槛与计数，但只能去机器人里改（按钮换成说明）", async () => {
    signIn(130);
    const fetch = stubFetch(() => ({ body: { topics: [TOPIC] } }));

    const wrapper = mount(NotifyView);
    await flushPromises();

    expect(wrapper.text()).toContain("入群申请");
    expect(wrapper.text()).toContain("需要平台超管（240）");
    // 表格里没有「改门槛」按钮（弹窗里的说明文案不算）
    const editButtons = wrapper
      .findAll("tbody button")
      .filter((button) => button.text() === "改门槛");
    expect(editButtons).toHaveLength(0);
    fetch.restore();
  });

  it("加载失败时把服务端中文原因显示出来（不静默空表）", async () => {
    signIn(240);
    const fetch = stubFetch(
      (call: StubbedCall): { status?: number; body?: unknown } =>
        call.path === "/api/notify/topics"
          ? { status: 503, body: { error: "unavailable", message: "推送服务未启用。" } }
          : { body: {} },
    );

    const wrapper = mount(NotifyView);
    await flushPromises();

    expect(wrapper.get(".error").text()).toContain("推送服务未启用");
    fetch.restore();
  });
});
