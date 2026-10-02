import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch, type StubbedCall } from "@/test/fetch";
import PermissionsView from "@/views/PermissionsView.vue";

/**
 * 权限页（P3，`/perm` 的管理面）。
 *
 * 口径（ADR-0060）：只有平台超管（240）能看能改；界面必须二次确认，
 * 并且把「改完谁多 / 少了什么」写清楚；回执里的 `changed` 要如实显示。
 */
const GROUP_REF = { kind: "group" as const, officialId: "g1", label: "50001" };
const USER_REF = { kind: "user" as const, officialId: "u1", label: "10001" };
const BOSS_REF = { kind: "user" as const, officialId: "boss", label: "10000" };

function signIn(platformLevel: number): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: platformLevel >= 240 ? "boss" : "mod",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: {
      platformLevel,
      groups: [{ groupId: "g1", level: 140, group: GROUP_REF }],
    },
  };
}

const GRANTS = {
  groups: [{ groupId: "g1", group: GROUP_REF }],
  global: [
    { role: "super", roleLabel: "全局超级管理员", members: [{ userId: "boss", user: BOSS_REF }] },
  ],
  group: {
    group: GROUP_REF,
    roles: [
      { role: "group_super", roleLabel: "本群超级管理员", members: [] },
      { role: "group_admin", roleLabel: "群管理员", members: [] },
      { role: "moderator", roleLabel: "审核员", members: [] },
    ],
  },
};

const CHANGE = {
  ok: true,
  action: "grant",
  role: "moderator",
  roleLabel: "审核员",
  group: GROUP_REF,
  target: USER_REF,
  changed: true,
  members: [{ userId: "u1", user: USER_REF }],
  message: "已授予 10001 审核员（50001）。",
};

describe("PermissionsView", () => {
  it("平台超管：列出全局与群内角色，授予要先二次确认再发请求", async () => {
    signIn(240);
    const fetch = stubFetch((call: StubbedCall) => {
      if (call.method === "POST") {
        return { body: CHANGE };
      }
      return { body: GRANTS };
    });

    const wrapper = mount(PermissionsView);
    await flushPromises();

    expect(wrapper.text()).toContain("全局超级管理员");
    expect(wrapper.text()).toContain("群管理员");
    // 默认选中第一个有授权的群
    expect(
      (wrapper.get("#perm-group").element as HTMLSelectElement).value,
    ).toBe("g1");
    expect(fetch.calls.some((call) => call.path === "/api/permissions?group=g1")).toBe(
      true,
    );

    await wrapper.get("#perm-role").setValue("moderator");
    await wrapper.get("#perm-target").setValue("10001");
    // 点「授予」只弹确认，不发请求
    const grantButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "授予");
    await grantButton!.trigger("click");
    await flushPromises();
    expect(fetch.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    // 弹窗把后果写清楚（默认 slot 里的说明文字）
    expect(wrapper.text()).toContain("授予后");
    expect(wrapper.text()).toContain("审核员");

    // 确认才发请求（写操作走 POST /api/permissions，带 CSRF 头）
    const confirm = wrapper
      .findAll("button")
      .find((button) => button.text() === "确认授予");
    await confirm!.trigger("click");
    await flushPromises();

    const post = fetch.calls.find((call) => call.method === "POST");
    expect(post).toMatchObject({
      path: "/api/permissions",
      body: { action: "grant", role: "moderator", group: "g1", userId: "10001" },
      csrf: true,
    });
    expect(wrapper.get(".ok").text()).toContain("已授予");
    fetch.restore();
  });

  it("撤销：确认文案写明「会失去什么」，危险按钮带 danger", async () => {
    signIn(240);
    const fetch = stubFetch((call: StubbedCall) =>
      call.method === "POST"
        ? {
            body: {
              ...CHANGE,
              action: "revoke",
              changed: false,
              members: [],
              message: "10001 本来就没有 审核员（50001），未改动。",
            },
          }
        : { body: GRANTS },
    );

    const wrapper = mount(PermissionsView);
    await flushPromises();
    await wrapper.get("#perm-role").setValue("moderator");
    await wrapper.get("#perm-target").setValue("10001");
    const revoke = wrapper
      .findAll("button")
      .find((button) => button.text() === "撤销");
    await revoke!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("撤销后");
    expect(wrapper.text()).toContain("会失去");
    const confirm = wrapper
      .findAll("button")
      .find((button) => button.text() === "确认撤销");
    expect(confirm!.classes()).toContain("danger");

    await confirm!.trigger("click");
    await flushPromises();
    // 没改动也如实回显（不假装成功）
    expect(wrapper.get(".ok").text()).toContain("未改动");
    fetch.restore();
  });

  it("非平台超管：不发请求，直接说明需要 240", async () => {
    signIn(140);
    const fetch = stubFetch(() => ({ body: GRANTS }));

    const wrapper = mount(PermissionsView);
    await flushPromises();

    expect(fetch.calls).toHaveLength(0);
    expect(wrapper.text()).toContain("需要平台超管（240）");
    fetch.restore();
  });

  it("没有任何有授权的群时：群角色点按钮只提示「先选一个群」，不发写请求", async () => {
    signIn(240);
    // 一个群都还没授权过：群下拉是空的（界面不该让群角色裸奔）
    const fetch = stubFetch(() => ({
      body: {
        groups: [],
        global: GRANTS.global,
      },
    }));

    const wrapper = mount(PermissionsView);
    await flushPromises();
    await wrapper.get("#perm-role").setValue("group_admin");
    await wrapper.get("#perm-target").setValue("u1");
    const grant = wrapper
      .findAll("button")
      .find((button) => button.text() === "授予");
    await grant!.trigger("click");
    await flushPromises();

    expect(wrapper.get(".error").text()).toContain("先选一个群");
    expect(fetch.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    fetch.restore();
  });
});
