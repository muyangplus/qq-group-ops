import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch } from "@/test/fetch";
import RulesView from "@/views/RulesView.vue";

/**
 * 规则页的收尾批次 E：
 * - 覆盖率总览（平台超管 240，只读）：哪些群覆盖了哪些字段；
 * - 一次改多项：攒清单 → 确认框里逐项 diff → **一次 PUT**（服务端先全校验再落库）。
 */
function signIn(platformLevel: number): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: platformLevel >= 240 ? "boss" : "admin",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: {
      platformLevel,
      groups: [
        {
          groupId: "g1",
          level: 130,
          group: {
            kind: "group" as const,
            officialId: "g1",
            label: "50001",
          },
        },
      ],
    },
  };
}

const RULES = {
  groupId: "g1",
  group: { kind: "group" as const, officialId: "g1", label: "50001" },
  override: { warningMessage: "旧文案" },
  settings: [],
  effective: { warningMessage: "旧文案", keywords: [] },
};

const OVERRIDES = {
  items: [
    {
      groupId: "g1",
      group: { kind: "group" as const, officialId: "g1", label: "50001" },
      fields: ["warningMessage", "keywords"],
      labels: ["警告语", "关键词"],
      fieldCount: 2,
    },
  ],
  totalGroups: 1,
  totalFields: 2,
};

function stubRules(): ReturnType<typeof stubFetch> {
  return stubFetch((call) => {
    if (call.path.startsWith("/api/rules/overrides")) {
      return { body: OVERRIDES };
    }
    if (call.method === "PUT") {
      return {
        body: {
          groupId: "g1",
          locale: "group",
          fields: ["warningMessage", "keywords"],
          changes: [
            {
              field: "warningMessage",
              label: "警告语",
              before: "旧文案",
              after: "新文案",
            },
            {
              field: "keywords",
              label: "关键词",
              before: "（未设置）",
              after: "刷屏",
            },
          ],
          message: "已更新群规则。",
        },
      };
    }
    return { body: RULES };
  });
}

describe("RulesView", () => {
  it("覆盖率总览：列出有覆盖的群与字段（平台超管）", async () => {
    signIn(240);
    const fetch = stubRules();

    const wrapper = mount(RulesView);
    await flushPromises();

    // 挂载时会请求两次规则（onMounted 里显式 load + 选中群触发的 watch）—— 只关心「有没有问过总览」
    expect(fetch.calls.map((call) => call.path)).toContain("/api/rules/overrides");
    expect(
      fetch.calls.filter((call) => call.path === "/api/rules/overrides"),
    ).toHaveLength(1);
    const table = wrapper.get("#rule-overrides");
    expect(table.text()).toContain("50001");
    expect(table.text()).toContain("警告语");
    expect(table.text()).toContain("关键词");
    expect(wrapper.text()).toContain("共 1 个群 · 2 个字段");
    fetch.restore();
  });

  it("一次改多项：清单出 diff、确认后才发一次 PUT（带 updates）", async () => {
    signIn(240);
    const fetch = stubRules();

    const wrapper = mount(RulesView);
    await flushPromises();

    // 第一项：改警告语（用**规范字段名**，清单里就能显示当前值）
    await wrapper.get("#rule-field").setValue("warningMessage");
    await wrapper.get("#rule-value").setValue("新文案");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "加入清单")!
      .trigger("click");
    // 第二项：加关键词
    await wrapper.get("#rule-field").setValue("keywords");
    await wrapper.get("#rule-value").setValue("刷屏");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "加入清单")!
      .trigger("click");

    const list = wrapper.get("#rule-batch");
    expect(list.findAll("tbody tr")).toHaveLength(2);
    // 清单里就给「旧值 → 新值」（旧值取当前生效值）
    expect(list.text()).toContain("旧文案");
    expect(list.text()).toContain("新文案");
    // 还没提交：没有 PUT
    expect(fetch.calls.some((call) => call.method === "PUT")).toBe(false);

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "提交 2 项")!
      .trigger("click");
    await flushPromises();
    // 确认框里逐项列 diff
    expect(wrapper.text()).toContain("确认一次改多项？");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "确认提交多项")!
      .trigger("click");
    await flushPromises();

    const put = fetch.calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe("/api/rules");
    expect(put?.csrf).toBe(true);
    expect(put?.body).toEqual({
      group: "g1",
      updates: [
        { field: "warningMessage", value: "新文案" },
        { field: "keywords", value: "刷屏" },
      ],
    });
    // 回执用服务端算的 diff；清单清空
    expect(wrapper.text()).toContain("已更新群规则");
    expect(wrapper.text()).toContain("警告语 旧文案 → 新文案");
    expect(wrapper.find("#rule-batch").exists()).toBe(false);
    fetch.restore();
  });

  it("非超管：不发覆盖率总览请求，也没有那一段", async () => {
    signIn(130);
    const fetch = stubRules();

    const wrapper = mount(RulesView);
    await flushPromises();

    expect(fetch.calls.map((call) => call.path)).toEqual([
      "/api/rules?group=g1",
      "/api/rules?group=g1",
    ]);
    expect(wrapper.find("#rule-overrides").exists()).toBe(false);
    fetch.restore();
  });
});
