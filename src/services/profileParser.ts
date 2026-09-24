import type { ClassAliasService } from "./classAliases.js";
import type { MemberRoster } from "./memberRoster.js";

/**
 * `/profile set` 的智能解析。
 *
 * 目标：用户**一次性**发一条消息（任意顺序、任意常用分隔符、甚至可以完全不带分隔符），
 * 自动识别出 班级 / 姓名 / 学号 / 学院 / 年级：
 *
 * ```text
 * /profile set 材化2211 张三 22123456789
 * /profile set 张三-22123456789-材化2211
 * /profile set 22123456789+材化2211+张三
 * /profile set 材化2211张三22123456789          ← 无分隔符也能识别
 * /profile set 班级=材化2211 姓名=张三 学号=22123456789
 * ```
 *
 * 识别规则：
 * - `字段=值` 显式写法优先，用于消歧；
 * - 11 位数字 = 学号；
 * - 能在班级库里匹配到的最长班级名 = 班级（无分隔符时靠这个切分）；
 * - 能在班级库里匹配到的最长学院名 = 学院（通常由班级自动带出，手填也能识别）；
 * - 剩下的 2-4 个连续汉字 = 姓名。
 *
 * **歧义/残留一律报错**（由调用方提示用户用 `字段=值` 明确指定），不会猜着写入。
 */
export type ProfileFieldKey =
  | "name"
  | "studentId"
  | "className"
  | "college"
  | "year";

export interface ProfileParseResult {
  fields: Partial<Record<ProfileFieldKey, string>>;
  /** 识别到的片段，用于回显（如「班级 材化2211」）。 */
  notes: string[];
  /** 有值时表示不能写入（歧义或存在无法识别的内容）。 */
  error?: string;
}

export interface ProfileParseOptions {
  roster?: MemberRoster | undefined;
  /** 别名表：班级/学院别名会先展开成规范名再识别（专业别名不参与）。 */
  aliases?: ClassAliasService | undefined;
}

const FIELD_KEYS: Record<string, ProfileFieldKey> = {
  name: "name",
  姓名: "name",
  名字: "name",
  id: "studentId",
  studentid: "studentId",
  student_id: "studentId",
  学号: "studentId",
  class: "className",
  classname: "className",
  班级: "className",
  college: "college",
  学院: "college",
  year: "year",
  年级: "year",
};

/** 常用分隔符：空格、`-`、`+`、`/`、`,`、`、`、`|`、`;`，以及中英文括号。 */
const SEPARATORS = /[\s\-+/,、|;；,，.。:：()（）【】\[\]]+/u;
const STUDENT_ID = /\d{11}/gu;
const NAME_TOKEN = /^[\u4e00-\u9fa5]{2,4}$/u;
const CHINESE_RUN = /[\u4e00-\u9fa5]{2,4}/gu;

/** 解析结果回显：识别到 X、Y（用于成功提示与报错提示）。 */
export function formatParseNotes(result: ProfileParseResult): string {
  return result.notes.length > 0 ? `识别到：${result.notes.join("、")}` : "未识别到有效字段";
}

export function parseProfileInput(
  raw: string,
  options: ProfileParseOptions = {},
): ProfileParseResult {
  const fields: Partial<Record<ProfileFieldKey, string>> = {};
  const notes: string[] = [];
  let working = raw.trim();
  if (working.length === 0) {
    return { fields, notes, error: "没有识别到任何内容。" };
  }

  // 0) 别名先展开成规范名（只展开班级/学院，专业别名对个人资料无意义）
  if (options.aliases) {
    working = options.aliases.expand(working, ["class", "college"]);
  }

  // 1) 显式 `字段=值`（优先级最高，可用于消歧）
  for (const match of [...working.matchAll(/([\p{L}_]+)\s*[=＝:：]\s*([^\s=＝:：]+)/gu)]) {
    const key = FIELD_KEYS[(match[1] ?? "").toLowerCase()];
    const value = (match[2] ?? "").trim();
    if (!key || value.length === 0) {
      continue;
    }
    fields[key] = value;
    notes.push(`${match[1]}=${value}`);
    working = working.replace(match[0], " ");
  }

  const roster = options.roster;

  // 2) 学号：11 位数字
  const ids = [...working.matchAll(STUDENT_ID)].map((match) => match[0]);
  if (ids.length > 1) {
    return {
      fields,
      notes,
      error: `识别到多个学号：${ids.join("、")}。请用「学号=…」明确指定。`,
    };
  }
  if (ids[0] !== undefined && fields.studentId === undefined) {
    fields.studentId = ids[0];
    notes.push(`学号 ${ids[0]}`);
  }
  working = working.replace(STUDENT_ID, " ");

  // 3) 班级：在剩余文本里反复匹配（最长优先），收集所有命中的班级
  const classNames = new Set<string>();
  if (roster) {
    for (let round = 0; round < 5; round += 1) {
      const match = roster.findClassIn(working);
      if (!match) {
        break;
      }
      classNames.add(match.className);
      working = working.replaceAll(match.className, " ");
    }
  }
  if (classNames.size > 1) {
    for (const name of classNames) {
      notes.push(`班级 ${name}`);
    }
    return {
      fields,
      notes,
      error: `识别到多个班级：${[...classNames].join("、")}。请用「班级=…」明确指定。`,
    };
  }
  const className = [...classNames][0];
  if (className !== undefined && fields.className === undefined) {
    fields.className = className;
    notes.push(`班级 ${className}`);
  }

  // 4) 学院：手填时也能识别（通常由班级自动带出）
  if (roster && fields.college === undefined) {
    const college = roster.findCollegeIn(working);
    if (college !== undefined) {
      fields.college = college;
      notes.push(`学院 ${college}`);
      working = working.replaceAll(college, " ");
    }
  }

  // 5) 姓名：剩余文本里的 2-4 个连续汉字
  if (fields.name === undefined) {
    const tokens = working
      .split(SEPARATORS)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    const tokenNames = tokens.filter((token) => NAME_TOKEN.test(token));
    const candidates =
      tokenNames.length > 0
        ? tokenNames
        : [...working.matchAll(CHINESE_RUN)].map((match) => match[0]);
    const unique = [...new Set(candidates)];
    if (unique.length > 1) {
      for (const name of unique) {
        notes.push(`姓名 ${name}`);
      }
      return {
        fields,
        notes,
        error: `识别到多个可能的姓名：${unique.join("、")}。请用「姓名=…」明确指定。`,
      };
    }
    if (unique[0] !== undefined) {
      fields.name = unique[0];
      notes.push(`姓名 ${unique[0]}`);
      working = working.replace(unique[0], " ");
    }
  }

  // 6) 残留检查：还有非分隔符内容就报错，避免"猜着写入"
  const leftovers = working
    .split(SEPARATORS)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (leftovers.length > 0) {
    return {
      fields,
      notes,
      error: `有内容无法识别：${leftovers.join("、")}。可用「班级=… 姓名=… 学号=…」明确指定。`,
    };
  }
  if (Object.keys(fields).length === 0) {
    return { fields, notes, error: "没有识别到班级 / 姓名 / 学号。" };
  }
  return { fields, notes };
}
