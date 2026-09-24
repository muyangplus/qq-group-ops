import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildClassIndex,
  parseYears,
  writeClassIndexJson,
  writeClassIndexSqlite,
} from "../scripts/classIndex.mjs";

const RAW = [
  { bj: "材化2211", zymc: "材料化学", jgmc: "化学与生命科学学院", njmc: "2022" },
  { bj: "材化2212", zymc: "材料化学", jgmc: "化学与生命科学学院", njmc: "2022" },
  { bj: "环工2414", zymc: "环境工程", jgmc: "环境科学与工程学院", njmc: "2024" },
  { bj: "老班2099", zymc: "古早专业", jgmc: "老学院", njdm_id: "1999" },
  { bj: "", zymc: "无班级", jgmc: "无学院", njmc: "2022" },
  null,
];

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "class-index-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseYears", () => {
  it("accepts 2-digit and 4-digit years", () => {
    expect(parseYears("2022-2026")).toEqual({ from: 2022, to: 2026 });
    expect(parseYears("22-26")).toEqual({ from: 2022, to: 2026 });
    expect(() => parseYears("abc")).toThrow(/2022-2026/u);
    expect(() => parseYears("2026-2022")).toThrow(/不合法/u);
  });
});

describe("buildClassIndex", () => {
  it("filters by year and builds class / major / college relations", () => {
    const { index, skipped, total } = buildClassIndex(RAW, {
      from: 2022,
      to: 2026,
      source: "data/class.json",
    });

    expect(total).toBe(RAW.length);
    expect(skipped).toBe(2); // 空班级名 + null
    // 排序按中文 localeCompare（材 < 环）
    expect(index.classes).toEqual(["材化2211", "材化2212", "环工2414"]);
    expect(index.majors).toEqual(["材料化学", "环境工程"]);
    expect(index.colleges).toEqual(["化学与生命科学学院", "环境科学与工程学院"]);
    expect(index.classInfo["材化2211"]).toEqual({
      major: "材料化学",
      college: "化学与生命科学学院",
      year: "2022",
    });
    expect(index.collegeMajors["化学与生命科学学院"]).toEqual(["材料化学"]);
    expect(index.majorColleges["环境工程"]).toEqual("环境科学与工程学院");
    // 1999 级被过滤掉
    expect(index.classes).not.toContain("老班2099");
    expect(index.source).toBe("data/class.json");
    expect(index.yearFrom).toBe(2022);
    expect(index.yearTo).toBe(2026);
  });

  it("rejects a non-array top level", () => {
    expect(() => buildClassIndex({}, { from: 2022, to: 2026, source: "x" })).toThrow(
      /数组/u,
    );
  });
});

describe("class index artifacts", () => {
  it("writes JSON and SQLite copies that agree with each other", () => {
    const dir = tempDir();
    const jsonFile = join(dir, "class-index.json");
    const sqliteFile = join(dir, "class-index.sqlite");
    const { index } = buildClassIndex(RAW, {
      from: 2022,
      to: 2026,
      source: "data/class.json",
    });

    writeClassIndexJson(index, jsonFile);
    expect(JSON.parse(readFileSync(jsonFile, "utf8"))).toEqual(index);

    writeClassIndexSqlite(index, sqliteFile);
    const db = new DatabaseSync(sqliteFile);
    try {
      const meta = Object.fromEntries(
        db
          .prepare("SELECT key, value FROM meta")
          .all()
          .map((row) => [row.key, row.value]),
      );
      expect(meta.classCount).toBe(String(index.classes.length));
      expect(meta.majorCount).toBe(String(index.majors.length));
      expect(meta.collegeCount).toBe(String(index.colleges.length));

      const classes = db
        .prepare("SELECT className, major, college, year FROM classes ORDER BY className")
        .all();
      expect(classes).toEqual([
        {
          className: "材化2211",
          major: "材料化学",
          college: "化学与生命科学学院",
          year: "2022",
        },
        {
          className: "材化2212",
          major: "材料化学",
          college: "化学与生命科学学院",
          year: "2022",
        },
        {
          className: "环工2414",
          major: "环境工程",
          college: "环境科学与工程学院",
          year: "2024",
        },
      ]);

      const majors = db
        .prepare("SELECT name, college FROM majors ORDER BY name")
        .all();
      expect(majors).toEqual([
        { name: "材料化学", college: "化学与生命科学学院" },
        { name: "环境工程", college: "环境科学与工程学院" },
      ]);
    } finally {
      db.close();
    }

    // 重复生成不报错（内部会先删除旧文件）
    writeClassIndexSqlite(index, sqliteFile);
  });
});
