#!/usr/bin/env node
/**
 * 把教务导出的班级原始数据转换成机器人可用的「班级 / 专业 / 学院索引」。
 *
 * 用法：
 *   pnpm class:index
 *
 * 环境变量：
 *   CLASS_RAW_FILE            原始 JSON 路径，默认 data/class.json
 *   CLASS_INDEX_FILE          JSON 输出路径，默认 data/class-index.json
 *   CLASS_INDEX_SQLITE_FILE   SQLite 输出路径，默认 data/class-index.sqlite（设 `-` 可跳过）
 *   CLASS_INDEX_YEARS         年级范围，默认 2022-2026（含两端）
 *
 * 输出两份产物（`data/` 已在 .gitignore 中，不会提交真实班级数据）：
 *
 * 1) JSON（机器人运行时加载的就是它，`CLASS_INDEX_FILE`）：
 *   {
 *     "generatedAt": "...",
 *     "source": "data/class.json",
 *     "yearFrom": 2022, "yearTo": 2026,
 *     "classes": ["材化2211", ...],        // 去重排序后的班级名
 *     "majors": ["材料化学", ...],          // 去重排序后的专业名
 *     "classInfo": { "材化2211": { "major": "...", "college": "...", "year": "2022" } },
 *     "colleges": ["化学与生命科学学院", ...],
 *     "collegeMajors": { "化学与生命科学学院": ["材料化学", ...] },
 *     "majorColleges": { "材料化学": "化学与生命科学学院" }
 *   }
 *
 * 2) SQLite（供离线分析 / 别名表联查，表结构与 JSON 一一对应）：
 *   meta(key PK, value)            生成时间、来源、年级范围
 *   colleges(name PK)
 *   majors(name PK, college)
 *   classes(className PK, major, college, year)
 */
import { readFileSync } from "node:fs";

import {
  buildClassIndex,
  parseYears,
  writeClassIndexJson,
  writeClassIndexSqlite,
} from "./classIndex.mjs";

const rawFile = process.env.CLASS_RAW_FILE ?? "data/class.json";
const outFile = process.env.CLASS_INDEX_FILE ?? "data/class-index.json";
const sqliteOut =
  process.env.CLASS_INDEX_SQLITE_FILE ?? "data/class-index.sqlite";
const yearsRange = process.env.CLASS_INDEX_YEARS ?? "2022-2026";

const { from, to } = parseYears(yearsRange);

const raw = JSON.parse(readFileSync(rawFile, "utf8"));
const { index, skipped, total } = buildClassIndex(raw, {
  from,
  to,
  source: rawFile,
});

writeClassIndexJson(index, outFile);

let sqliteMessage = `SQLite：${sqliteOut}`;
if (sqliteOut === "-" || sqliteOut === "") {
  sqliteMessage = "SQLite：已跳过（CLASS_INDEX_SQLITE_FILE=-）";
} else {
  writeClassIndexSqlite(index, sqliteOut);
  sqliteMessage =
    `SQLite：${sqliteOut}\n` +
    `  表：meta / colleges(${index.colleges.length}) / ` +
    `majors(${index.majors.length}) / classes(${index.classes.length})`;
}

console.log(
  `班级索引已生成：${outFile}\n` +
    `  年级范围：${from}-${to}\n` +
    `  班级：${index.classes.length} 个\n` +
    `  专业：${index.majors.length} 个\n` +
    `  学院：${index.colleges.length} 个\n` +
    `  原始记录：${total} 条（跳过 ${skipped} 条无效记录）\n` +
    `  ${sqliteMessage}`,
);
