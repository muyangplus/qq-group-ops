import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch, type StubbedCall } from "@/test/fetch";
import ActivitiesView from "@/views/ActivitiesView.vue";

/**
 * 活动页（E2-c + P2 第四/五批）的组件测试：新建草稿、改字段、发布群绑定。
 *
 * 口径来自 docs/ADMIN-API.md 的 E1-k：字段写法与 `/activity set` 一致（`clear` 也能用），
 * 门槛 130；绑定数 > 1 才给「解绑」（最后一行会回落到归属群）。
 */
const GROUP_REF = { kind: "group" as const, officialId: "g1", label: "50001" };

function signIn(level: number): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: "admin",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { platformLevel: 0, groups: [{ groupId: "g1", level, group: GROUP_REF }] },
  };
}

function activityItem(capacity: number | undefined): Record<string, unknown> {
  return {
    activityId: "a1",
    code: "ACT001",
    title: "周三晚自习",
    groupId: "g1",
    status: "draft",
    registered: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    group: GROUP_REF,
    boundGroups: [GROUP_REF],
    ...(capacity !== undefined ? { capacity } : {}),
  };
}

const FIELDS = [
  {
    field: "capacity",
    label: "名额",
    kind: "number",
    aliases: ["capacity", "名额"],
    clearable: true,
    hint: "正整数；clear = 不限名额",
    notifiesParticipants: true,
  },
  {
    field: "waitlistPromotion",
    label: "递补方式",
    kind: "mode",
    aliases: ["waitlistpromotion", "递补"],
    clearable: true,
    hint: "auto 自动递补 / manual 手动释放；clear = 手动",
    notifiesParticipants: false,
  },
];

/** 页面挂载后的固定动作：等 `onMounted` 里的两个请求都落地。 */
async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(ActivitiesView);
  await flushPromises();
  return wrapper;
}

describe("ActivitiesView", () => {
  it("列表渲染 + 字段目录进下拉（字段表来自服务端），绑定数 = 1 时不给「解绑」", async () => {
    signIn(130);
    const fetch = stubFetch((call: StubbedCall) => {
      if (call.path.startsWith("/api/activities/fields")) {
        return { body: { fields: FIELDS } };
      }
      return { body: { total: 1, page: 1, pageSize: 20, items: [activityItem(undefined)] } };
    });

    const wrapper = await mountView();

    expect(wrapper.text()).toContain("周三晚自习");
    const options = wrapper
      .get("#activity-field-ACT001")
      .findAll("option")
      .map((option) => option.text());
    expect(options).toContain("名额");
    expect(options).toContain("递补方式");
    // 只绑了归属群（1 个）：不能解绑
    expect(wrapper.find(".chips .chip-with-action button").exists()).toBe(false);
    fetch.restore();
  });

  it("改字段：写法与 /activity set 一致，回执显示「旧值 → 新值」并刷新列表", async () => {
    signIn(130);
    let capacity: number | undefined = undefined;
    const fetch = stubFetch((call: StubbedCall) => {
      if (call.method === "PUT" && call.path === "/api/activities/ACT001") {
        const body = call.body as { field: string; value: string };
        expect(body).toEqual({ field: "capacity", value: "10" });
        capacity = Number(body.value);
        return {
          body: {
            ok: true,
            activity: activityItem(capacity),
            field: "capacity",
            fieldLabel: "名额",
            before: "不限",
            after: "10",
            message: "**结果**：已更新 capacity。",
          },
        };
      }
      if (call.path.startsWith("/api/activities/fields")) {
        return { body: { fields: FIELDS } };
      }
      return {
        body: { total: 1, page: 1, pageSize: 20, items: [activityItem(capacity)] },
      };
    });

    const wrapper = await mountView();
    await wrapper.get("#activity-field-ACT001").setValue("capacity");
    await wrapper.get("#activity-value-ACT001").setValue("10");
    await wrapper.get("#activity-field-save-ACT001").trigger("click");
    await flushPromises();

    // 写操作要带 CSRF 头（api/client.ts 统一加）
    expect(fetch.calls.find((call) => call.method === "PUT")).toMatchObject({
      method: "PUT",
      path: "/api/activities/ACT001",
      csrf: true,
    });
    expect(wrapper.get(".ok").text()).toContain("名额");
    expect(wrapper.get(".ok").text()).toContain("不限 → 10");
    // 保存后重新拉列表：新名额显示出来
    expect(wrapper.text()).toContain("/ 10");
    fetch.restore();
  });

  it("新建活动：标题为空时按钮禁用；点一下发的是草稿请求（POST /api/activities）", async () => {
    signIn(130);
    const fetch = stubFetch((call: StubbedCall) => {
      if (call.method === "POST") {
        return {
          body: {
            ok: true,
            activity: { ...activityItem(undefined), code: "NEW001" },
            boundGroups: [GROUP_REF],
            message: "已新建活动草稿 #NEW001「周三晚自习」。",
          },
        };
      }
      if (call.path.startsWith("/api/activities/fields")) {
        return { body: { fields: FIELDS } };
      }
      return { body: { total: 0, page: 1, pageSize: 20, items: [] } };
    });

    const wrapper = await mountView();
    const button = wrapper
      .findAll("button")
      .find((candidate) => candidate.text() === "新建活动");
    expect(button, "找不到「新建活动」按钮").toBeDefined();
    // 归属群 + 标题都填了才让点（少一个都是草稿的硬前提）
    expect(button!.attributes("disabled")).toBeDefined();

    await wrapper.get("#activity-new-group").setValue("g1");
    expect(button!.attributes("disabled")).toBeDefined();
    await wrapper.get("#activity-new-title").setValue("周三晚自习");
    expect(button!.attributes("disabled")).toBeUndefined();

    await button!.trigger("click");
    await flushPromises();

    const post = fetch.calls.find((call) => call.method === "POST");
    expect(post).toMatchObject({
      path: "/api/activities",
      body: { group: "g1", title: "周三晚自习" },
      csrf: true,
    });
    expect(wrapper.get(".ok").text()).toContain("草稿");
    fetch.restore();
  });

  it("门槛：本群 120（审核员）看到列表，但新建 / 绑定 / 改字段都不可操作", async () => {
    signIn(120);
    const fetch = stubFetch((call: StubbedCall) => {
      if (call.path.startsWith("/api/activities/fields")) {
        return { body: { fields: FIELDS } };
      }
      return { body: { total: 1, page: 1, pageSize: 20, items: [activityItem(20)] } };
    });

    const wrapper = await mountView();

    expect(wrapper.text()).toContain("周三晚自习");
    // 够 120 能看列表，但没有任何可管理的群：新建的归属群下拉是空的、改字段那块不渲染
    expect(wrapper.find("#activity-field-ACT001").exists()).toBe(false);
    expect(wrapper.get("#activity-new-group").attributes("disabled")).toBeDefined();
    fetch.restore();
  });
});
