import { describe, expect, it } from "vitest";

import { MemberRoster } from "../src/services/memberRoster.js";
import {
  formatParseNotes,
  parseProfileInput,
} from "../src/services/profileParser.js";

const roster = MemberRoster.fromIndex({
  classes: ["材化2211", "环工2414"],
  majors: ["材料化学", "环境工程"],
  classInfo: {
    材化2211: {
      major: "材料化学",
      college: "化学与生命科学学院",
      year: "2022",
    },
    环工2414: { major: "环境工程", college: "环境科学与工程学院", year: "2024" },
  },
});

describe("parseProfileInput", () => {
  it("recognizes class, name and student id in any order (space separated)", () => {
    const a = parseProfileInput("20220123456 材化2211 张三", { roster });
    expect(a.error).toBeUndefined();
    expect(a.fields).toMatchObject({
      studentId: "20220123456",
      className: "材化2211",
      name: "张三",
    });

    const b = parseProfileInput("张三 材化2211 20220123456", { roster });
    expect(b.fields).toMatchObject({
      studentId: "20220123456",
      className: "材化2211",
      name: "张三",
    });
  });

  it("accepts -, + and / separators", () => {
    for (const separator of ["-", "+", "/"]) {
      const parts = ["张三", "材化2211", "20220123456"].join(separator);
      const result = parseProfileInput(parts, { roster });
      expect(result.error, parts).toBeUndefined();
      expect(result.fields, parts).toMatchObject({
        name: "张三",
        className: "材化2211",
        studentId: "20220123456",
      });
    }
  });

  it("recognizes the three fields without any separator", () => {
    const result = parseProfileInput("材化2211张三20220123456", { roster });
    expect(result.error).toBeUndefined();
    expect(result.fields).toMatchObject({
      className: "材化2211",
      name: "张三",
      studentId: "20220123456",
    });
  });

  it("supports explicit 字段=值 for disambiguation", () => {
    const result = parseProfileInput("班级=材化2211 姓名=王五 学号=20220123456", {
      roster,
    });
    expect(result.error).toBeUndefined();
    expect(result.fields).toMatchObject({
      className: "材化2211",
      name: "王五",
      studentId: "20220123456",
    });
  });

  it("recognizes a college given by hand and the year field", () => {
    const result = parseProfileInput("化学与生命科学学院 李四 年级=2023", {
      roster,
    });
    expect(result.error).toBeUndefined();
    expect(result.fields).toMatchObject({
      college: "化学与生命科学学院",
      name: "李四",
      year: "2023",
    });
  });

  it("reports every candidate instead of guessing when two classes match", () => {
    const result = parseProfileInput("材化2211 环工2414 张三", { roster });
    expect(result.fields.className).toBeUndefined();
    expect(result.error).toContain("多个班级");
    expect(result.error).toContain("材化2211");
    expect(result.error).toContain("环工2414");
    // 识别结果要一起回显，方便用户改写
    expect(result.notes.length).toBeGreaterThan(0);
    expect(formatParseNotes(result)).toContain("识别到：");
  });

  it("reports every candidate when two names are possible", () => {
    const result = parseProfileInput("材化2211 张三 李四 20220123456", { roster });
    expect(result.fields.name).toBeUndefined();
    expect(result.error).toContain("多个可能的姓名");
    expect(result.error).toContain("张三");
    expect(result.error).toContain("李四");
    expect(formatParseNotes(result)).toContain("姓名 张三");
  });

  it("reports multiple student ids", () => {
    const result = parseProfileInput("20220123456 20230123456 材化2211 张三", {
      roster,
    });
    expect(result.error).toContain("多个学号");
  });

  it("refuses leftover content it cannot classify", () => {
    const result = parseProfileInput("材化2211 张三 abc", { roster });
    expect(result.error).toContain("无法识别");
    expect(result.error).toContain("abc");
    // 解析结果里可以带上已识别的字段，但 error 存在时调用方必须整体不落库
    expect(result.fields.name).toBe("张三");
  });

  it("errors on empty input", () => {
    expect(parseProfileInput("   ", { roster }).error).toContain("没有识别到");
    expect(
      parseProfileInput("bilibili", { roster }).error,
    ).toContain("无法识别");
  });

  it("works without a class library (id + name only)", () => {
    const result = parseProfileInput("张三 20220123456", {});
    expect(result.error).toBeUndefined();
    expect(result.fields).toMatchObject({
      name: "张三",
      studentId: "20220123456",
    });
    expect(result.fields.className).toBeUndefined();
  });

  it("formats notes for successful parses", () => {
    const result = parseProfileInput("材化2211 张三 20220123456", { roster });
    const notes = formatParseNotes(result);
    expect(notes).toContain("班级 材化2211");
    expect(notes).toContain("姓名 张三");
    expect(notes).toContain("学号 20220123456");
  });
});
