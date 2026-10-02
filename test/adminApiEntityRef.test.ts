import { describe, expect, it } from "vitest";

import {
  createAdminApiEntities,
  previewOfficialId,
} from "../src/adminApi/entityRef.js";

/**
 * 管理后台展示层（E2-e）：**选择与交互优先出绑定号（QQ号 / 群号），其次短码，
 * 完整官方长码只该出现在「详情」里**。
 *
 * 这里钉住三件事：优先级、只查不造短码、以及没数据源时的兜底（截断的官方 id）。
 */
describe("createAdminApiEntities", () => {
  const entities = createAdminApiEntities({
    qqOf: (userId) => (userId === "u1" ? "10002" : undefined),
    groupNumberOf: (groupId) => (groupId === "g1" ? "50001" : undefined),
    shortCodeOf: (kind, targetId) =>
      kind === "join_request" && targetId === "r1"
        ? "ABC123"
        : kind === "group" && targetId === "g2"
          ? "ZZ9999"
          : kind === "user" && targetId === "u2"
            ? "QQ0001"
            : undefined,
  });

  it("有绑定号的实体：label 就是群号 / QQ号，短码仍单独给出", () => {
    expect(entities.group("g1")).toEqual({
      kind: "group",
      officialId: "g1",
      label: "50001",
      externalId: "50001",
    });
    expect(entities.user("u1")).toEqual({
      kind: "user",
      officialId: "u1",
      label: "10002",
      externalId: "10002",
    });
  });

  it("绑定号优先于短码：两者都有时 label 用绑定号，shortCode 仍然带出来", () => {
    const ref = createAdminApiEntities({
      qqOf: () => "10001",
      shortCodeOf: () => "ABCDEF",
    }).user("u1");

    expect(ref.label).toBe("10001");
    expect(ref.externalId).toBe("10001");
    expect(ref.shortCode).toBe("#ABCDEF");
  });

  it("没有绑定号就用短码（含 `#`）", () => {
    expect(entities.group("g2")).toEqual({
      kind: "group",
      officialId: "g2",
      label: "#ZZ9999",
      shortCode: "#ZZ9999",
    });
    expect(entities.user("u2").label).toBe("#QQ0001");
  });

  it("申请一律先看短码（申请没有绑定号一说）", () => {
    expect(entities.request("r1")).toEqual({
      kind: "request",
      officialId: "r1",
      label: "#ABC123",
      shortCode: "#ABC123",
    });
  });

  it("都没有 → 截断后的官方 id（完整值仍在 officialId 里）", () => {
    const long = "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS";
    const ref = entities.group(long);

    expect(ref.label).toBe(previewOfficialId(long));
    expect(ref.label).toBe("SSSSSSSS…SSSS");
    expect(ref.officialId).toBe(long);
    expect(ref.externalId).toBeUndefined();
    expect(ref.shortCode).toBeUndefined();
  });

  it("短码只查不造：数据源不返回就当作没有（列表页不该给历史数据发码）", () => {
    const created: string[] = [];
    const ref = createAdminApiEntities({
      shortCodeOf: (kind, targetId) => {
        created.push(`${kind}:${targetId}`);
        return undefined;
      },
    }).user("u9");

    expect(created).toEqual(["user:u9"]);
    expect(ref.shortCode).toBeUndefined();
    expect(ref.label).toBe("u9");
  });

  it("完全没有数据源也能用（只读巡检 / 单测的兜底）", () => {
    expect(createAdminApiEntities().group("g1")).toEqual({
      kind: "group",
      officialId: "g1",
      label: "g1",
    });
  });

  it("previewOfficialId：短 id 原样返回，超限才头 8 尾 4", () => {
    expect(previewOfficialId("g1")).toBe("g1");
    expect(previewOfficialId("ABCDEFGH")).toBe("ABCDEFGH");
    // 正好等于上限（8 + 4）不截断
    expect(previewOfficialId("ABCDEFGHIJKL")).toBe("ABCDEFGHIJKL");
    expect(previewOfficialId("ABCDEFGHIJKLMNOP")).toBe("ABCDEFGH…MNOP");
  });
});
