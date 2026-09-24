import { getLogger } from "../core/logger.js";
import type { ClassAliasRepository } from "../db/classAliasRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import { compactText, type MemberRoster } from "./memberRoster.js";

const log = getLogger("class-aliases");

/** 别名指向的目标类型：班级 / 学院 / 专业（由目标在班级库里的身份自动判定）。 */
export type ClassAliasKind = "class" | "college" | "major";

export interface ClassAlias {
  /** 用户习惯的写法（保留原样，仅用于展示）。 */
  alias: string;
  /** 班级库里的规范名。 */
  target: string;
  kind: ClassAliasKind;
}

export const CLASS_ALIAS_KIND_LABELS: Record<ClassAliasKind, string> = {
  class: "班级",
  college: "学院",
  major: "专业",
};

export class ClassAliasError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClassAliasError";
  }
}

/**
 * 班级/学院/专业**别名表**（全局生效，由全局超管维护）。
 *
 * 用途：把用户习惯但不在班级库里的写法映射到规范名，例如
 * `环工2214` → `环境类2214`、`化生学院` → `化学与生命科学学院`。
 * 别名会被用于：
 *
 * - `/profile set` 的智能识别（别名先展开成规范名，再走班级/学院匹配）；
 * - 入群审核的「班级+姓名」匹配（回答里写别名也能命中班级）。
 *
 * 别名与规范名的匹配都忽略空白差异，且**长别名优先**（避免短别名抢先命中）。
 */
export class ClassAliasService {
  /** key = 去空白后的别名（小写不敏感由 compactText 之外单独处理）。 */
  private readonly aliases = new Map<string, ClassAlias>();
  private readonly repository: ClassAliasRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private roster: MemberRoster | undefined;

  public constructor(repository?: ClassAliasRepository, queue?: WriteQueue) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public setRoster(roster: MemberRoster | undefined): void {
    this.roster = roster;
  }

  public get rosterAvailable(): boolean {
    return this.roster !== undefined;
  }

  public get size(): number {
    return this.aliases.size;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const rows = await this.repository.findAll();
    this.aliases.clear();
    for (const row of rows) {
      this.aliases.set(compactText(row.alias), row);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public list(): ClassAlias[] {
    return [...this.aliases.values()].sort((left, right) =>
      left.alias.localeCompare(right.alias, "zh"),
    );
  }

  public get(alias: string): ClassAlias | undefined {
    return this.aliases.get(compactText(alias));
  }

  /** 某个规范名上挂的所有别名（用于展示）。 */
  public aliasesFor(target: string): string[] {
    return this.list()
      .filter((entry) => entry.target === target)
      .map((entry) => entry.alias);
  }

  /**
   * 新增/覆盖一条别名。目标必须是班级库里的班级 / 学院 / 专业，
   * 类型由目标本身自动判定（不需要用户填）。
   */
  public set(alias: string, target: string): ClassAlias {
    const trimmedAlias = alias.trim();
    const trimmedTarget = target.trim();
    const key = compactText(trimmedAlias);
    if (key.length === 0) {
      throw new ClassAliasError("别名不能为空");
    }
    if (trimmedAlias.length > 40) {
      throw new ClassAliasError("别名最长 40 个字符");
    }
    const roster = this.roster;
    if (!roster) {
      throw new ClassAliasError(
        "班级库未加载，先在服务器执行 pnpm class:index 并重启机器人",
      );
    }
    const kind = this.kindOf(trimmedTarget, roster);
    if (!kind) {
      throw new ClassAliasError(
        `目标「${trimmedTarget}」不在班级库里，必须是班级 / 学院 / 专业之一`,
      );
    }
    if (compactText(trimmedTarget) === key) {
      throw new ClassAliasError("别名不能和规范名完全相同");
    }
    const existing = this.aliases.get(key);
    const entry: ClassAlias = { alias: trimmedAlias, target: trimmedTarget, kind };
    this.aliases.set(key, entry);
    if (this.repository) {
      this.queue?.enqueue("class-alias.save", () =>
        this.repository!.save(entry),
      );
    }
    log.info("class alias saved", {
      alias: trimmedAlias,
      target: trimmedTarget,
      kind,
      replaced: existing !== undefined,
    });
    return entry;
  }

  /** 删除别名；返回是否真的删掉了。 */
  public remove(alias: string): boolean {
    const key = compactText(alias);
    const existing = this.aliases.get(key);
    if (!existing) {
      return false;
    }
    this.aliases.delete(key);
    if (this.repository) {
      this.queue?.enqueue("class-alias.remove", () =>
        this.repository!.remove(existing.alias),
      );
    }
    log.info("class alias removed", { alias: existing.alias });
    return true;
  }

  /**
   * 把文本里命中的别名替换成规范名（最长别名优先），
   * 让后续的班级/学院匹配既能吃规范名也能吃别名。
   */
  public expand(
    text: string,
    kinds: readonly ClassAliasKind[] = ["class", "college", "major"],
  ): string {
    if (this.aliases.size === 0) {
      return text;
    }
    let result = text;
    for (const entry of this.matching(text, kinds)) {
      // 允许文本里别名中间带空白（匹配时本来就忽略空白）
      result = result.replace(aliasPattern(entry.alias), entry.target);
    }
    return result;
  }

  /** 文本里命中的第一个别名（最长优先），供展示「命中了哪条别名」。 */
  public findIn(
    text: string,
    kinds: readonly ClassAliasKind[] = ["class", "college", "major"],
  ): ClassAlias | undefined {
    return this.matching(text, kinds)[0];
  }

  /** 文本里命中的所有别名（长别名优先、不重复）。 */
  private matching(
    text: string,
    kinds: readonly ClassAliasKind[],
  ): ClassAlias[] {
    const compact = compactText(text);
    if (compact.length === 0) {
      return [];
    }
    return this.list()
      .filter((entry) => kinds.includes(entry.kind))
      .filter((entry) => compact.includes(compactText(entry.alias)))
      .sort(
        (left, right) =>
          compactText(right.alias).length - compactText(left.alias).length,
      );
  }

  private kindOf(
    target: string,
    roster: MemberRoster,
  ): ClassAliasKind | undefined {
    if (roster.hasClass(target)) {
      return "class";
    }
    if (roster.listColleges().includes(target)) {
      return "college";
    }
    if (roster.listMajors().includes(target)) {
      return "major";
    }
    return undefined;
  }
}

/** 别名 → 正则：允许字符之间夹任意空白（`环工2214` 也能匹配 `环工 2214`）。 */
function aliasPattern(alias: string): RegExp {
  const body = [...alias]
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s*");
  return new RegExp(body, "gu");
}
