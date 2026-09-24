/**
 * `pnpm class:index` 的核心逻辑（纯函数 + 产物写出），供 CLI 与测试共用。
 *
 * 详见 scripts/build-class-index.mjs 的头部说明。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function parseYears(spec) {
  const match = /^(\d{2,4})\s*-\s*(\d{2,4})$/u.exec(String(spec).trim());
  if (!match) {
    throw new Error(`CLASS_INDEX_YEARS 需要形如 2022-2026，收到：${spec}`);
  }
  const normalize = (value) => {
    const year = Number.parseInt(value, 10);
    return year < 100 ? 2000 + year : year;
  };
  const from = normalize(match[1]);
  const to = normalize(match[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error(`CLASS_INDEX_YEARS 范围不合法：${spec}`);
  }
  return { from, to };
}

/**
 * 把教务原始记录整理成索引对象。
 *
 * @param {unknown} raw 原始 JSON（顶层数组）
 * @param {{ from: number, to: number, source: string }} options
 * @returns {{ index: object, skipped: number, total: number }}
 */
export function buildClassIndex(raw, { from, to, source }) {
  if (!Array.isArray(raw)) {
    throw new Error("原始数据顶层必须是数组");
  }
  const classes = new Map();
  const majors = new Set();
  let skipped = 0;

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      skipped += 1;
      continue;
    }
    const className = String(item.bj ?? "").trim();
    const year = String(item.njmc ?? item.njdm_id ?? "").trim();
    const yearNumber = Number.parseInt(year, 10);
    if (!className || !Number.isFinite(yearNumber)) {
      skipped += 1;
      continue;
    }
    if (yearNumber < from || yearNumber > to) {
      continue;
    }
    const major = String(item.zymc ?? "").trim();
    const college = String(item.jgmc ?? "").trim();
    classes.set(className, { major, college, year: String(yearNumber) });
    if (major) {
      majors.add(major);
    }
  }

  const classInfo = Object.fromEntries(
    [...classes.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh")),
  );

  // 学院 ↔ 专业对照：一个专业只归一个学院（取班级库里第一次出现的那个）
  const majorColleges = new Map();
  const collegeMajors = new Map();
  for (const info of classes.values()) {
    if (!info.college || !info.major) {
      continue;
    }
    if (!majorColleges.has(info.major)) {
      majorColleges.set(info.major, info.college);
    }
    if (!collegeMajors.has(info.college)) {
      collegeMajors.set(info.college, new Set());
    }
    collegeMajors.get(info.college).add(info.major);
  }

  const index = {
    generatedAt: new Date().toISOString(),
    source,
    yearFrom: from,
    yearTo: to,
    classes: [...classes.keys()].sort((a, b) => a.localeCompare(b, "zh")),
    majors: [...majors].sort((a, b) => a.localeCompare(b, "zh")),
    classInfo,
    colleges: [...collegeMajors.keys()].sort((a, b) => a.localeCompare(b, "zh")),
    collegeMajors: Object.fromEntries(
      [...collegeMajors.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], "zh"))
        .map(([college, list]) => [
          college,
          [...list].sort((a, b) => a.localeCompare(b, "zh")),
        ]),
    ),
    majorColleges: Object.fromEntries(
      [...majorColleges.entries()].sort((a, b) =>
        a[0].localeCompare(b[0], "zh"),
      ),
    ),
  };

  return { index, skipped, total: raw.length };
}

export function writeClassIndexJson(index, outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(index)}\n`, "utf8");
}

/** 写一份与 JSON 一一对应的 SQLite：meta / colleges / majors / classes。 */
export function writeClassIndexSqlite(index, sqliteFile) {
  mkdirSync(dirname(sqliteFile), { recursive: true });
  // 重新生成而不是增量更新：保证产物与本次 JSON 完全一致
  rmSync(sqliteFile, { force: true });
  const db = new DatabaseSync(sqliteFile);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE colleges (name TEXT PRIMARY KEY);
      CREATE TABLE majors (name TEXT PRIMARY KEY, college TEXT);
      CREATE TABLE classes (
        className TEXT PRIMARY KEY,
        major TEXT,
        college TEXT,
        year TEXT
      );
      CREATE INDEX idx_majors_college ON majors(college);
      CREATE INDEX idx_classes_college ON classes(college);
      CREATE INDEX idx_classes_major ON classes(major);
    `);
    const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insertMeta.run("generatedAt", index.generatedAt);
    insertMeta.run("source", index.source);
    insertMeta.run("yearFrom", String(index.yearFrom));
    insertMeta.run("yearTo", String(index.yearTo));
    insertMeta.run("classCount", String(index.classes.length));
    insertMeta.run("majorCount", String(index.majors.length));
    insertMeta.run("collegeCount", String(index.colleges.length));

    const insertCollege = db.prepare("INSERT INTO colleges (name) VALUES (?)");
    const insertMajor = db.prepare(
      "INSERT INTO majors (name, college) VALUES (?, ?)",
    );
    const insertClass = db.prepare(
      "INSERT INTO classes (className, major, college, year) VALUES (?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const college of index.colleges) {
        insertCollege.run(college);
      }
      for (const major of index.majors) {
        insertMajor.run(major, index.majorColleges[major] ?? null);
      }
      for (const className of index.classes) {
        const info = index.classInfo[className];
        insertClass.run(
          className,
          info?.major ?? null,
          info?.college ?? null,
          info?.year ?? null,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
