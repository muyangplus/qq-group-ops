import { beforeEach, describe, expect, it } from "vitest";

import type { ClassAliasRepository } from "../src/db/classAliasRepository.js";
import {
  ClassAliasError,
  ClassAliasService,
  type ClassAlias,
} from "../src/services/classAliases.js";
import { MemberRoster } from "../src/services/memberRoster.js";

class FakeClassAliasRepository implements ClassAliasRepository {
  public readonly rows = new Map<string, ClassAlias>();

  public async findAll(): Promise<ClassAlias[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  public async save(entry: ClassAlias): Promise<void> {
    this.rows.set(entry.alias, { ...entry });
  }

  public async remove(alias: string): Promise<void> {
    this.rows.delete(alias);
  }
}

function roster(): MemberRoster {
  return MemberRoster.fromIndex({
    classes: ["材化2211", "环境类2214"],
    majors: ["材料化学", "环境工程"],
    classInfo: {
      材化2211: {
        major: "材料化学",
        college: "化学与生命科学学院",
        year: "2022",
      },
      环境类2214: {
        major: "环境工程",
        college: "环境科学与工程学院",
        year: "2022",
      },
    },
  });
}

describe("ClassAliasService", () => {
  let service: ClassAliasService;

  beforeEach(() => {
    service = new ClassAliasService();
    service.setRoster(roster());
  });

  it("infers the target kind from the class library", () => {
    expect(service.set("环工2214", "环境类2214").kind).toBe("class");
    expect(service.set("化生学院", "化学与生命科学学院").kind).toBe("college");
    expect(service.set("材料化学系", "材料化学").kind).toBe("major");
  });

  it("rejects unknown targets, empty aliases and self-mapping", () => {
    expect(() => service.set("", "环境类2214")).toThrow(ClassAliasError);
    expect(() => service.set("环工2214", "不存在的班级")).toThrow(/不在班级库/u);
    expect(() => service.set("环境类2214", "环境类2214")).toThrow(/不能和规范名/u);
  });

  it("refuses to save when the roster is not loaded", () => {
    const noRoster = new ClassAliasService();
    expect(() => noRoster.set("环工2214", "环境类2214")).toThrow(
      /班级库未加载/u,
    );
  });

  it("lists, looks up and removes aliases (ignoring whitespace)", () => {
    service.set("环工2214", "环境类2214");
    service.set("化生学院", "化学与生命科学学院");

    expect(service.size).toBe(2);
    expect(service.list().map((entry) => entry.alias)).toEqual([
      "化生学院",
      "环工2214",
    ]);
    expect(service.get(" 环工2214 ")?.target).toBe("环境类2214");
    expect(service.aliasesFor("环境类2214")).toEqual(["环工2214"]);
    expect(service.aliasesFor("环境类2215")).toEqual([]);

    expect(service.remove("环工 2214")).toBe(true);
    expect(service.remove("环工2214")).toBe(false);
    expect(service.size).toBe(1);
  });

  it("overwrites an existing alias", () => {
    service.set("环工2214", "环境类2214");
    const replaced = service.set("环工2214", "材化2211");

    expect(replaced.kind).toBe("class");
    expect(service.size).toBe(1);
    expect(service.get("环工2214")?.target).toBe("材化2211");
  });

  it("expands aliases in text (longest first, whitespace-insensitive)", () => {
    service.set("环工", "材化2211");
    service.set("环工2214", "环境类2214");

    // 长别名先替换，短别名不会把长别名切碎
    expect(service.expand("我是环工2214的小明")).toBe("我是环境类2214的小明");
    expect(service.expand("环工 2214 张三")).toBe("环境类2214 张三");
    // 长别名替换后剩下的短别名仍会展开
    expect(service.expand("环工的张三")).toBe("材化2211的张三");
    // 未命中保持原样
    expect(service.expand("计算机类2201")).toBe("计算机类2201");
  });

  it("only expands the kinds asked for", () => {
    service.set("环工2214", "环境类2214");
    service.set("化生学院", "化学与生命科学学院");

    expect(service.expand("化生学院 环工2214", ["class"])).toBe(
      "化生学院 环境类2214",
    );
    expect(service.expand("化生学院 环工2214", ["college"])).toBe(
      "化学与生命科学学院 环工2214",
    );
  });

  it("finds the first matching alias for display", () => {
    service.set("环工2214", "环境类2214");
    service.set("化生学院", "化学与生命科学学院");

    expect(service.findIn("我是环工2214的张三")?.alias).toBe("环工2214");
    expect(service.findIn("我是环工2214的张三", ["college"])).toBeUndefined();
  });

  it("persists aliases and restores them after a restart", async () => {
    const repository = new FakeClassAliasRepository();
    const first = new ClassAliasService(repository);
    first.setRoster(roster());
    first.set("环工2214", "环境类2214");
    first.set("化生学院", "化学与生命科学学院");
    first.remove("化生学院");
    await first.flush();

    const restarted = new ClassAliasService(repository);
    await restarted.load();
    expect(restarted.list()).toEqual([
      { alias: "环工2214", target: "环境类2214", kind: "class" },
    ]);
  });
});
