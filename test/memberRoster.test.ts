import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MemberRoster } from "../src/services/memberRoster.js";

const syntheticIndex = {
  yearFrom: 2022,
  yearTo: 2026,
  classes: ["材化2211", "材化2212", "计科2201", "软件工程2301"],
  majors: ["材料化学", "计算机科学与技术", "软件工程"],
  classInfo: {
    材化2211: {
      major: "材料化学",
      college: "化学与生命科学学院",
      year: "2022",
    },
    计科2201: {
      major: "计算机科学与技术",
      college: "计算机学院",
      year: "2022",
    },
  },
};

const CLASS_INDEX_FILE = "data/class-index.json";

describe("MemberRoster", () => {
  const roster = MemberRoster.fromIndex(syntheticIndex);

  it("finds a class inside the answer regardless of spacing", () => {
    expect(roster.findClassIn("材化2211 张三")?.className).toBe("材化2211");
    expect(roster.findClassIn("材化 2211 张三")?.className).toBe("材化2211");
    expect(roster.findClassIn("我是材化2211张三")?.className).toBe("材化2211");
    expect(roster.findClassIn("张三")).toBeUndefined();
  });

  it("returns class metadata for the opinion", () => {
    expect(roster.infoFor("材化2211")).toEqual({
      major: "材料化学",
      college: "化学与生命科学学院",
      year: "2022",
    });
    expect(roster.classCount).toBe(4);
    expect(roster.majorCount).toBe(3);
  });

  it("prefers explicitly labelled names", () => {
    expect(roster.extractName("材化2211 姓名：张三")).toBe("张三");
    expect(roster.extractName("我叫李四，材化2211")).toBe("李四");
  });

  it("skips majors, colleges and label words when guessing names", () => {
    expect(roster.extractName("材料化学 材化2211 张三", "材化2211")).toBe("张三");
    expect(
      roster.extractName("化学与生命科学学院 材化2211 李四", "材化2211"),
    ).toBe("李四");
    expect(roster.extractName("材化2211 申请入群", "材化2211")).toBeUndefined();
  });

  it("returns undefined when the answer has no name", () => {
    expect(roster.extractName("材化2211", "材化2211")).toBeUndefined();
    expect(roster.extractName("", "材化2211")).toBeUndefined();
  });

  it("rejects malformed index payloads", () => {
    expect(() => MemberRoster.fromIndex(null)).toThrow(/必须是对象/u);
    const empty = MemberRoster.fromIndex({});
    expect(empty.classCount).toBe(0);
    expect(empty.findClassIn("材化2211")).toBeUndefined();
  });
});

describe.skipIf(!existsSync(CLASS_INDEX_FILE))(
  "MemberRoster with the generated class index",
  () => {
    it("loads the real index and matches a real class", async () => {
      const roster = await MemberRoster.load(CLASS_INDEX_FILE);
      expect(roster).toBeDefined();
      expect(roster?.classCount).toBeGreaterThan(800);
      expect(roster?.majorCount).toBeGreaterThan(50);

      const sample = roster?.findClassIn("材化2211 张三");
      expect(sample?.className).toBe("材化2211");
      expect(sample?.info?.major).toBeTruthy();

      // 索引只包含 22-26 级：2009 级不应命中
      expect(roster?.findClassIn("材化0911 张三")).toBeUndefined();
    });

    it("returns undefined for a missing index file", async () => {
      await expect(MemberRoster.load("data/__missing__.json")).resolves.toBeUndefined();
    });
  },
);
