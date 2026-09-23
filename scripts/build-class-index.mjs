#!/usr/bin/env node
/**
 * 把教务导出的班级原始数据转换成机器人可用的「班级 / 专业索引」。
 *
 * 用法：
 *   pnpm class:index
 *
 * 环境变量：
 *   CLASS_RAW_FILE    原始 JSON 路径，默认 data/class.json
 *   CLASS_INDEX_FILE  输出路径，默认 data/class-index.json
 *   CLASS_INDEX_YEARS 年级范围，默认 2022-2026（含两端）
 *
 * 输出结构（data/ 已在 .gitignore 中，不会提交真实班级数据）：
 *   {
 *     "generatedAt": "...",
 *     "source": "data/class.json",
 *     "yearFrom": 2022, "yearTo": 2026,
 *     "classes": ["材化2211", ...],        // 去重排序后的班级名
 *     "majors": ["材料化学", ...],          // 去重排序后的专业名
 *     "classInfo": { "材化2211": { "major": "...", "college": "...", "year": "2022" } }
 *   }
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const rawFile = process.env.CLASS_RAW_FILE ?? "data/class.json";
const outFile = process.env.CLASS_INDEX_FILE ?? "data/class-index.json";
const yearsRange = process.env.CLASS_INDEX_YEARS ?? "2022-2026";

function parseYears(spec) {
  const match = /^(\d{2,4})\s*-\s*(\d{2,4})$/u.exec(spec.trim());
  if (!match) {
    throw new Error(`CLASS_INDEX_YEARS 需要形如 2022-2026，收到：${spec}`);
  }
  const normalize = (value) => {
    const year = Number.parseInt(value, 10);
    return year < 100 ? 2000 + year : year;
  };
  const from = normalize(match[1]);
  const to = normalize(match[2]);
  return { from, to };
}

const { from, to } = parseYears(yearsRange);

const raw = JSON.parse(readFileSync(rawFile, "utf8"));
if (!Array.isArray(raw)) {
  throw new Error(`${rawFile} 顶层必须是数组`);
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

const index = {
  generatedAt: new Date().toISOString(),
  source: rawFile,
  yearFrom: from,
  yearTo: to,
  classes: [...classes.keys()].sort((a, b) => a.localeCompare(b, "zh")),
  majors: [...majors].sort((a, b) => a.localeCompare(b, "zh")),
  classInfo: Object.fromEntries(
    [...classes.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh")),
  ),
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(index)}\n`, "utf8");

console.log(
  `班级索引已生成：${outFile}\n` +
    `  年级范围：${from}-${to}\n` +
    `  班级：${index.classes.length} 个\n` +
    `  专业：${index.majors.length} 个\n` +
    `  原始记录：${raw.length} 条（跳过 ${skipped} 条无效记录）`,
);
