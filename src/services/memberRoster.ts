import { readFile } from "node:fs/promises";

import { getLogger } from "../core/logger.js";

const log = getLogger("member-roster");

export interface ClassInfo {
  major: string;
  college: string;
  year: string;
}

export interface ClassMatch {
  className: string;
  info: ClassInfo | undefined;
}

/**
 * 班级库。
 *
 * 数据来自 `pnpm class:index`（把教务导出的原始 JSON 过滤成 22-26 级的班级/专业索引）。
 * 索引缺失时返回 `undefined`，对应的入群规则会退化为「人工审核」，不会误放行。
 */
export class MemberRoster {
  private readonly classes: readonly string[];
  private readonly classInfo: ReadonlyMap<string, ClassInfo>;
  private readonly blockedWords: readonly string[];
  private readonly majors: readonly string[];

  private constructor(
    classes: readonly string[],
    classInfo: ReadonlyMap<string, ClassInfo>,
    blockedWords: readonly string[],
    majors: readonly string[],
  ) {
    // 长班级名优先，避免「材化2211」被更短的别名抢先匹配
    this.classes = [...classes].sort((a, b) => b.length - a.length);
    this.classInfo = classInfo;
    this.blockedWords = blockedWords;
    this.majors = majors;
  }

  public static async load(filePath: string): Promise<MemberRoster | undefined> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        log.warn("班级索引不存在，入群规则将退化为人工审核", {
          file: filePath,
          hint: "运行 pnpm class:index 生成",
        });
        return undefined;
      }
      throw error;
    }

    try {
      return MemberRoster.fromIndex(JSON.parse(text));
    } catch (error) {
      log.error("班级索引解析失败", {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  public static fromIndex(raw: unknown): MemberRoster {
    if (!isRecord(raw)) {
      throw new Error("班级索引必须是对象");
    }
    const classes = Array.isArray(raw.classes)
      ? raw.classes.filter((item): item is string => typeof item === "string")
      : [];
    const majors = Array.isArray(raw.majors)
      ? raw.majors.filter((item): item is string => typeof item === "string")
      : [];

    const classInfo = new Map<string, ClassInfo>();
    const colleges = new Set<string>();
    if (isRecord(raw.classInfo)) {
      for (const [className, value] of Object.entries(raw.classInfo)) {
        if (!isRecord(value)) {
          continue;
        }
        const major = typeof value.major === "string" ? value.major : "";
        const college = typeof value.college === "string" ? value.college : "";
        const year = typeof value.year === "string" ? value.year : "";
        classInfo.set(className, { major, college, year });
        if (college) {
          colleges.add(college);
        }
      }
    }

    return new MemberRoster(
      classes,
      classInfo,
      [
        ...majors,
        ...colleges,
        "班级",
        "专业",
        "年级",
        "学院",
        "大学",
        "同学",
        "姓名",
        "名字",
      ],
      majors,
    );
  }

  public get classCount(): number {
    return this.classes.length;
  }

  public get majorCount(): number {
    return this.majors.length;
  }

  public hasClass(className: string): boolean {
    return this.classInfo.has(className) || this.classes.includes(className);
  }

  public infoFor(className: string): ClassInfo | undefined {
    return this.classInfo.get(className);
  }

  /** 在入群答案里找出班级名；会忽略空白差异。 */
  public findClassIn(text: string): ClassMatch | undefined {
    const compact = compactText(text);
    for (const className of this.classes) {
      if (compact.includes(className)) {
        return { className, info: this.classInfo.get(className) };
      }
    }
    return undefined;
  }

  /**
   * 从入群答案里提取姓名。
   *
   * 优先识别「姓名：张三」这类显式标注，否则取第一个 2-4 个汉字、
   * 且不是专业/学院/常见词的一段。
   */
  public extractName(text: string, className?: string): string | undefined {
    const labeled =
      /(?:姓名|名字|我叫|我是)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/u.exec(text);
    if (labeled?.[1]) {
      return labeled[1];
    }

    let working = text;
    if (className) {
      working = working.replaceAll(className, " ");
    }
    working = working.replace(
      /(?:姓名|名字|我叫|我是|学号|班级|专业|年级|学院|申请入群|想加入|入群)[:：]?/gu,
      " ",
    );

    // 按「最大连续汉字段」切分，避免把「化学与生命科学学院」切成 4 字片段误判为姓名
    for (const run of working.match(/[\u4e00-\u9fa5]+/gu) ?? []) {
      if (run.length < 2 || run.length > 4) {
        continue;
      }
      if (this.isBlockedWord(run)) {
        continue;
      }
      return run;
    }
    return undefined;
  }

  private isBlockedWord(candidate: string): boolean {
    return this.blockedWords.some(
      (word) => word === candidate || word.startsWith(candidate),
    );
  }
}

function compactText(text: string): string {
  return text.replace(/\s+/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
