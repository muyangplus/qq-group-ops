import { describe, expect, it } from "vitest";

import { adminApi } from "@/api/admin";
import { ApiError } from "@/api/client";
import { stubFetch } from "@/test/fetch";

/**
 * `api/admin.ts` 的**响应形状映射**（P2「前端组件测试底座」）。
 *
 * 这层最容易出的 bug 是「服务端回 `{ topics }`，前端当数组用」—— 扫源码的契约守卫抓不到，
 * 组件测试又只看渲染结果，所以这里直接把 HTTP 边界造假、断言映射后的形状。
 */
describe("adminApi 的响应形状映射", () => {
  it("notifyTopics 拆开服务端的 { topics }（通知页表格曾经永远是空的）", async () => {
    const fetch = stubFetch(() => ({
      body: {
        topics: [
          {
            topic: "join",
            label: "入群申请",
            hint: "有新的入群申请时推给能审批的人",
            defaultLevel: 130,
            level: 130,
            allScope: 2,
            groupScopes: 5,
          },
        ],
      },
    }));

    const topics = await adminApi.notifyTopics();

    expect(topics.map((topic) => topic.topic)).toEqual(["join"]);
    expect(fetch.calls[0]).toMatchObject({ method: "GET", path: "/api/notify/topics" });
    fetch.restore();
  });

  it("activitySettingFields 拆开服务端的 { fields }，字段名 / 中文名照搬", async () => {
    const fetch = stubFetch(() => ({
      body: {
        fields: [
          {
            field: "capacity",
            label: "名额",
            kind: "number",
            aliases: ["capacity", "名额"],
            clearable: true,
            hint: "正整数；clear = 不限名额",
            notifiesParticipants: true,
          },
        ],
      },
    }));

    const fields = await adminApi.activitySettingFields();

    expect(fields).toHaveLength(1);
    expect(fields[0]?.field).toBe("capacity");
    expect(fields[0]?.label).toBe("名额");
    expect(fetch.calls[0]?.path).toBe("/api/activities/fields");
    fetch.restore();
  });

  it("写操作自动带 CSRF 头与 JSON 请求体（改活动字段）", async () => {
    const fetch = stubFetch(() => ({
      body: {
        ok: true,
        activity: {
          activityId: "a1",
          code: "ACT001",
          title: "春游",
          groupId: "g1",
          status: "draft",
          registered: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
          group: { kind: "group", officialId: "g1", label: "50001" },
          boundGroups: [{ kind: "group", officialId: "g1", label: "50001" }],
        },
        field: "capacity",
        fieldLabel: "名额",
        before: "不限",
        after: "10",
        message: "**结果**：已更新 capacity。",
      },
    }));

    const result = await adminApi.updateActivityField("ACT001", "capacity", "10");

    expect(result.after).toBe("10");
    expect(fetch.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/activities/ACT001",
      body: { field: "capacity", value: "10" },
      csrf: true,
    });
    fetch.restore();
  });

  it("非 2xx：抛带状态与错误码的 ApiError（页面据此显示中文原因）", async () => {
    const fetch = stubFetch(() => ({
      status: 403,
      body: { error: "forbidden", message: "权限不足：需要本群群管理员（130）。" },
    }));

    await expect(
      adminApi.updateActivityField("ACT001", "title", "x"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      code: "forbidden",
      message: "权限不足：需要本群群管理员（130）。",
    });
    await expect(
      adminApi.updateActivityField("ACT001", "title", "x"),
    ).rejects.toBeInstanceOf(ApiError);
    fetch.restore();
  });
});
