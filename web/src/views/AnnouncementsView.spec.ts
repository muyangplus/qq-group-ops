import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch } from "@/test/fetch";
import AnnouncementsView from "@/views/AnnouncementsView.vue";

/**
 * 定时发言页（TODO §2 的 P0）：本群群管 130 自治。
 *
 * 关注点：列表把**后五次执行时间**摆出来 · 总开关关着要提示 · 新建默认停用 ·
 * 表单的形态 / 按钮校验 · 删除与试发都要二次确认。
 */
const GROUP_REF = { kind: "group" as const, officialId: "g1", label: "50001" };
const USER_REF = { kind: "user" as const, officialId: "admin", label: "10003" };

function signIn(groups: Array<{ groupId: string; level: number }>): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: "admin",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: {
      platformLevel: 0,
      groups: groups.map((group) => ({ ...group, group: GROUP_REF })),
    },
  };
}

const ITEM = {
  id: "a1",
  groupId: "g1",
  group: GROUP_REF,
  cron: "0 9 * * *",
  enabled: true,
  mode: "card" as const,
  title: "作业提醒",
  text: "该交作业了",
  quote: "原文",
  buttons: [{ label: "查看", command: "/activity", reply: false }],
  reference: false,
  nextTimes: [
    "2026-10-04 09:00",
    "2026-10-05 09:00",
    "2026-10-06 09:00",
    "2026-10-07 09:00",
    "2026-10-08 09:00",
  ],
  createdBy: USER_REF,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

const VIEW = { items: [ITEM], total: 1, enabled: true, hourlyLimit: 6 };

describe("AnnouncementsView", () => {
  it("列出本群任务：时间表、形态、后五次执行时间都在", async () => {
    signIn([{ groupId: "g1", level: 130 }]);
    const fetch = stubFetch(() => ({ body: VIEW }));

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    expect(fetch.calls[0]?.path).toBe("/api/scheduled-announcements?group=g1");
    const table = wrapper.get("#announcement-list").text();
    expect(table).toContain("0 9 * * *");
    expect(table).toContain("卡片 + 引用块 + 1 个按钮");
    expect(table).toContain("该交作业了");
    expect(table).toContain("2026-10-08 09:00");
    expect(table).toContain("已启用");
    // 后面还有 4 次也要给出来（用户要求「查询时返回后五次」）
    expect(table).toContain("2026-10-04 09:00");
    fetch.restore();
  });

  it("没有 130 的群时不发请求，直接说明", async () => {
    signIn([{ groupId: "g1", level: 120 }]);
    const fetch = stubFetch(() => ({ body: VIEW }));

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    expect(fetch.calls).toHaveLength(0);
    expect(wrapper.get(".error").text()).toContain("130");
    fetch.restore();
  });

  it("总开关关着时如实提示「都不会触发」", async () => {
    signIn([{ groupId: "g1", level: 130 }]);
    const fetch = stubFetch(() => ({ body: { ...VIEW, enabled: false } }));

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    expect(wrapper.get("#announcement-switch-off").text()).toContain("都不会触发");
    fetch.restore();
  });

  it("新建：POST 到本群，正文 / 形态 / 按钮都按填的传，回执提示默认停用", async () => {
    signIn([{ groupId: "g1", level: 130 }]);
    const fetch = stubFetch((call) =>
      call.method === "POST"
        ? {
            body: {
              ok: true,
              message: "已新建定时发言（默认停用；确认内容与时间表后再启用）。",
              announcements: VIEW,
            },
          }
        : { body: { ...VIEW, items: [], total: 0 } },
    );

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    await wrapper.get("#announcement-cron").setValue("0 9 * * *");
    await wrapper.get("#announcement-mode").setValue("card");
    await wrapper.get("#announcement-title").setValue("作业提醒");
    await wrapper.get("#announcement-text").setValue("该交作业了");
    await wrapper.get("#announcement-buttons").setValue("查看 /activity");
    await wrapper.get("#announcement-reference").setValue(true);
    await wrapper.get("#announcement-form").trigger("submit");
    await flushPromises();

    const post = fetch.call(1);
    expect(post?.method).toBe("POST");
    expect(post?.path).toBe("/api/scheduled-announcements");
    expect(post?.csrf).toBe(true);
    expect(post?.body).toEqual({
      group: "g1",
      cron: "0 9 * * *",
      mode: "card",
      title: "作业提醒",
      text: "该交作业了",
      reference: true,
      buttons: [{ label: "查看", command: "/activity" }],
    });
    expect(wrapper.get("#announcement-notice").text()).toContain("默认停用");
    fetch.restore();
  });

  it("按钮行写法不对 / 超过 5 个：本地就拦住，不发请求", async () => {
    signIn([{ groupId: "g1", level: 130 }]);
    const fetch = stubFetch(() => ({ body: { ...VIEW, items: [], total: 0 } }));

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    await wrapper.get("#announcement-cron").setValue("0 9 * * *");
    await wrapper.get("#announcement-text").setValue("正文");
    await wrapper.get("#announcement-buttons").setValue("没有指令的按钮");
    await wrapper.get("#announcement-form").trigger("submit");
    await flushPromises();
    expect(wrapper.get("#announcement-notice").text()).toContain("按钮文字 指令");
    expect(fetch.calls).toHaveLength(1);

    await wrapper
      .get("#announcement-buttons")
      .setValue(
        ["一 /a", "二 /b", "三 /c", "四 /d", "五 /e", "六 /f"].join("\n"),
      );
    await wrapper.get("#announcement-form").trigger("submit");
    await flushPromises();
    expect(wrapper.get("#announcement-notice").text()).toContain("最多 5 个");
    expect(fetch.calls).toHaveLength(1);
    fetch.restore();
  });

  it("启停 / 删除 / 试发：走对应端点，删除与试发先弹确认框", async () => {
    signIn([{ groupId: "g1", level: 130 }]);
    const fetch = stubFetch((call) => {
      if (call.method === "PUT") {
        return {
          body: { ok: true, message: "已停用：不会触发（任务保留）。", announcements: VIEW },
        };
      }
      if (call.method === "DELETE") {
        return { body: { ok: true, message: "已删除定时发言。", announcements: { ...VIEW, items: [], total: 0 } } };
      }
      if (call.method === "POST") {
        return { body: { ok: true, message: "已立即发一条。", announcements: VIEW } };
      }
      return { body: VIEW };
    });

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    // 停用
    const buttons = wrapper.findAll("#announcement-list button");
    const stop = buttons.find((button) => button.text() === "停用");
    await stop!.trigger("click");
    await flushPromises();
    expect(fetch.call(1)?.method).toBe("PUT");
    expect(fetch.call(1)?.path).toBe("/api/scheduled-announcements/a1");
    expect(fetch.call(1)?.body).toEqual({ enabled: false });

    // 删除要先确认（弹框没确认前不发请求）
    const remove = wrapper.findAll("#announcement-list button").find(
      (button) => button.text() === "删除",
    );
    await remove!.trigger("click");
    await flushPromises();
    expect(fetch.calls).toHaveLength(2);
    expect(wrapper.find("dialog").exists()).toBe(true);

    // 试发同样先确认
    const send = wrapper.findAll("#announcement-list button").find(
      (button) => button.text() === "试发",
    );
    await send!.trigger("click");
    await flushPromises();
    expect(fetch.calls).toHaveLength(2);
    fetch.restore();
  });

  it("编辑：把这条载入表单，保存走 PUT 并且仍然带 cron", async () => {
    signIn([{ groupId: "g1", level: 130 }]);
    const fetch = stubFetch((call) =>
      call.method === "PUT"
        ? { body: { ok: true, message: "已保存定时发言。", announcements: VIEW } }
        : { body: VIEW },
    );

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    const edit = wrapper
      .findAll("#announcement-list button")
      .find((button) => button.text() === "编辑");
    await edit!.trigger("click");
    await flushPromises();

    expect((wrapper.get("#announcement-title").element as HTMLInputElement).value).toBe(
      "作业提醒",
    );
    await wrapper.get("#announcement-text").setValue("改后的正文");
    await wrapper.get("#announcement-form").trigger("submit");
    await flushPromises();

    const put = fetch.call(1);
    expect(put?.method).toBe("PUT");
    expect(put?.path).toBe("/api/scheduled-announcements/a1");
    expect(put?.body).toMatchObject({
      cron: "0 9 * * *",
      text: "改后的正文",
    });
    fetch.restore();
  });

  it("服务端报错：原样显示中文原因", async () => {
    signIn([{ groupId: "g1", level: 130 }]);
    const fetch = stubFetch(() => ({
      status: 403,
      body: { error: "forbidden", message: "权限不足：需要该群的群管理员或以上权限。" },
    }));

    const wrapper = mount(AnnouncementsView);
    await flushPromises();

    expect(wrapper.get(".error").text()).toContain("需要该群的群管理员");
    fetch.restore();
  });
});
