import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import EntityLabel from "@/components/EntityLabel.vue";

/**
 * 展示层的统一口径（E2-e）：正文优先出「人念得出来的名字」，完整官方长码收进「详情」。
 * 组件测试底座的第一批用例就钉这条 —— 之前只有扫源码的契约守卫，改错渲染没人拦。
 */
describe("EntityLabel", () => {
  it("群：正文出群号，详情里给短码与完整 group_openid", () => {
    const wrapper = mount(EntityLabel, {
      props: {
        entity: {
          kind: "group",
          officialId: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
          label: "50001",
          externalId: "50001",
          shortCode: "#G7K2Q9",
        },
        fallback: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
      },
    });

    expect(wrapper.get(".entity-label").text()).toBe("50001");
    const details = wrapper.get(".entity-details").text();
    expect(details).toContain("群号");
    expect(details).toContain("#G7K2Q9");
    expect(details).toContain("群 ID（group_openid）");
  });

  it("全局默认群显示成「全局默认」，不显示成 __default__", () => {
    const wrapper = mount(EntityLabel, {
      props: {
        entity: { kind: "group", officialId: "__default__", label: "__default__" },
        fallback: "__default__",
      },
    });

    expect(wrapper.get(".entity-label").text()).toBe("全局默认");
  });

  it("没有展示信息时退回 fallback；详情和正文一样就不必折叠", () => {
    const wrapper = mount(EntityLabel, {
      props: { fallback: "u_1234567890" },
    });

    expect(wrapper.get(".entity-label").text()).toBe("u_1234567890");
    expect(wrapper.find(".entity-details").exists()).toBe(false);
  });
});
