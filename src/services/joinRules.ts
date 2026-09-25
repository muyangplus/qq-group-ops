import { JoinDecisionMode } from "../core/enums.js";
import type { ClassAliasService } from "./classAliases.js";
import type { EffectiveGroupConfig } from "./groupConfig.js";
import type { MemberRoster } from "./memberRoster.js";

export { JoinDecisionMode };

export type JoinAction = "approve" | "reject" | "manual";

export interface JoinRuleSettings {
  mode: JoinDecisionMode;
  requireClass: boolean;
  requireName: boolean;
  /** 可选的额外正则要求（对原始答案求值）。 */
  answerPattern?: string | undefined;
  /** 学院白名单（命中班级库里的学院才能通过）。 */
  allowColleges?: readonly string[] | undefined;
  /** 学院黑名单。 */
  denyColleges?: readonly string[] | undefined;
  /** 年级白名单（班级库四位年份与面板两位写法都接受）。 */
  allowYears?: readonly string[] | undefined;
  /** 年级黑名单。 */
  denyYears?: readonly string[] | undefined;
  /** 人工审核时是否给出审核意见。 */
  opinionEnabled: boolean;
}

export interface JoinEvaluation {
  /** 是否满足全部已配置的要求。 */
  matched: boolean;
  className?: string | undefined;
  name?: string | undefined;
  major?: string | undefined;
  college?: string | undefined;
  year?: string | undefined;
  /** 缺少或不符合的项。 */
  missing: string[];
  /** 规则自身有问题（例如正则写错、没配置任何要求）。 */
  configIssue?: string | undefined;
  action: JoinAction;
  /** 审核意见；未开启或无需人工审核时为空字符串。 */
  opinion: string;
}

/**
 * 入群审核规则评估。
 *
 * 规则来源：群配置的 `joinDecisionMode` + `joinRequireClass` / `joinRequireName` /
 * `joinAnswerPattern`。班级来自 `pnpm class:index` 生成的班级库。
 */
export class JoinRuleEvaluator {
  private roster: MemberRoster | undefined;
  private aliases: ClassAliasService | undefined;

  public constructor(roster?: MemberRoster) {
    this.roster = roster;
  }

  /** 班级库是异步加载的，运行时可后置注入。 */
  public setRoster(roster: MemberRoster | undefined): void {
    this.roster = roster;
  }

  /** 别名表同样是运行时可后置注入；回答里写别名也能命中班级。 */
  public setAliases(aliases: ClassAliasService | undefined): void {
    this.aliases = aliases;
  }

  public get rosterAvailable(): boolean {
    return this.roster !== undefined;
  }

  public evaluate(answer: string, settings: JoinRuleSettings): JoinEvaluation {
    const roster = this.roster;
    // 别名先展开成规范名，再做班级/姓名匹配（自定义正则仍匹配原始回答）
    const expanded =
      this.aliases?.expand(answer, ["class", "college"]) ?? answer;
    const classMatch = roster?.findClassIn(expanded);
    const name = roster?.extractName(expanded, classMatch?.className);

    const requiresClass = settings.requireClass;
    const requiresName = settings.requireName;
    const pattern = settings.answerPattern?.trim() ?? "";
    // 名单筛选（学院 / 年级 白黑名单）：同样算「已配置的规则」
    const allowColleges = settings.allowColleges ?? [];
    const denyColleges = settings.denyColleges ?? [];
    const allowYears = settings.allowYears ?? [];
    const denyYears = settings.denyYears ?? [];
    const rosterRules =
      allowColleges.length > 0 ||
      denyColleges.length > 0 ||
      allowYears.length > 0 ||
      denyYears.length > 0;
    const hasRequirements =
      requiresClass || requiresName || pattern.length > 0 || rosterRules;

    let missing: string[] = [];
    let configIssue: string | undefined;
    let patternMatched = true;

    if (requiresClass && !classMatch) {
      missing.push("班级");
    }
    if (requiresName && !name) {
      missing.push("姓名");
    }
    if (pattern.length > 0) {
      try {
        patternMatched = new RegExp(pattern, "u").test(answer);
        if (!patternMatched) {
          missing.push(`自定义规则 /${pattern}/`);
        }
      } catch (error) {
        configIssue = `自定义规则不是合法正则：${
          error instanceof Error ? error.message : String(error)
        }`;
        missing.push("自定义规则（配置错误）");
      }
    }
    // 名单筛选：学院 / 年级取自班级库（只有识别到班级才能拿到这两项）。
    // 名单是**硬约束**：命中黑名单或不在白名单内一律按拒绝处理，
    // 不能被 auto_approve / approve_on_match 这类模式绕过；`manual` 模式仍交人工。
    const college = classMatch?.info?.college ?? "";
    const year = classMatch?.info?.year ?? "";
    let hardBlocked = false;
    if (roster && rosterRules) {
      const hitCollege = (list: readonly string[]): boolean =>
        college.length > 0 && list.some((value) => sameText(value, college));
      const hitYear = (list: readonly string[]): boolean =>
        year.length > 0 && list.some((value) => sameYear(value, year));
      if (denyColleges.length > 0 && hitCollege(denyColleges)) {
        missing.push(`学院黑名单（${college}）`);
        hardBlocked = true;
      }
      if (allowColleges.length > 0 && !hitCollege(allowColleges)) {
        missing.push(
          college.length > 0
            ? `学院白名单（不含 ${college}）`
            : "学院白名单（班级库未识别到学院）",
        );
        hardBlocked = true;
      }
      if (denyYears.length > 0 && hitYear(denyYears)) {
        missing.push(`年级黑名单（${year}）`);
        hardBlocked = true;
      }
      if (allowYears.length > 0 && !hitYear(allowYears)) {
        missing.push(
          year.length > 0 ? `年级白名单（不含 ${year}）` : "年级白名单（班级库未识别到年级）",
        );
        hardBlocked = true;
      }
    }
    if ((requiresClass || rosterRules) && !roster) {
      configIssue = "班级库未加载（请先运行 pnpm class:index）";
      missing = [
        ...new Set([
          ...missing,
          ...(requiresClass ? ["班级"] : []),
          ...(rosterRules ? ["学院 / 年级（班级库未加载）"] : []),
        ]),
      ];
    }
    if (
      !hasRequirements &&
      settings.mode !== JoinDecisionMode.Manual &&
      settings.mode !== JoinDecisionMode.AutoApprove &&
      configIssue === undefined
    ) {
      configIssue =
        "未配置入群审核规则（joinRequireClass / joinRequireName / joinAnswerPattern 都未设置）";
    }

    const matched = configIssue === undefined && missing.length === 0;
    const action =
      hardBlocked && settings.mode !== JoinDecisionMode.Manual
        ? "reject"
        : this.decide(settings.mode, matched, hasRequirements, configIssue);

    return {
      matched,
      className: classMatch?.className,
      name,
      major: classMatch?.info?.major,
      college: classMatch?.info?.college,
      year: classMatch?.info?.year,
      missing,
      ...(configIssue !== undefined ? { configIssue } : {}),
      action,
      opinion: settings.opinionEnabled
        ? this.buildOpinion(answer, settings, {
            matched,
            missing,
            action,
            hasRequirements,
            className: classMatch?.className,
            name,
            major: classMatch?.info?.major,
            college: classMatch?.info?.college,
            year: classMatch?.info?.year,
            configIssue,
          })
        : "",
    };
  }

  private decide(
    mode: JoinDecisionMode,
    matched: boolean,
    hasRequirements: boolean,
    configIssue: string | undefined,
  ): JoinAction {
    if (mode === JoinDecisionMode.AutoApprove) {
      return "approve";
    }
    if (mode === JoinDecisionMode.Manual) {
      return "manual";
    }
    // 需要按规则判断，但规则缺失或写错时不能猜，一律转人工
    if (configIssue !== undefined || !hasRequirements) {
      return "manual";
    }
    switch (mode) {
      case JoinDecisionMode.ApproveOnMatch:
        return matched ? "approve" : "manual";
      case JoinDecisionMode.RejectOnMatch:
        return matched ? "reject" : "manual";
      case JoinDecisionMode.RejectOnMismatch:
        return matched ? "manual" : "reject";
      default:
        return "manual";
    }
  }

  private buildOpinion(
    answer: string,
    settings: JoinRuleSettings,
    result: {
      matched: boolean;
      missing: string[];
      action: JoinAction;
      hasRequirements: boolean;
      className?: string | undefined;
      name?: string | undefined;
      major?: string | undefined;
      college?: string | undefined;
      year?: string | undefined;
      configIssue?: string | undefined;
    },
  ): string {
    const lines = ["审核意见（按当前入群规则自动生成）："];
    const hits: string[] = [];
    if (result.className) {
      const detail = [
        result.major,
        result.college,
        result.year ? `${result.year} 级` : undefined,
      ]
        .filter((item): item is string => Boolean(item))
        .join(" / ");
      hits.push(`班级 ${result.className}${detail ? `（${detail}）` : ""}`);
    }
    if (result.name) {
      hits.push(`姓名 ${result.name}`);
    }
    lines.push(
      hits.length > 0 ? `  识别到：${hits.join("、")}` : "  识别到：（无）",
    );
    if (result.configIssue) {
      lines.push(`  配置问题：${result.configIssue}`);
    } else if (result.missing.length > 0) {
      lines.push(`  缺少：${result.missing.join("、")}`);
    } else if (result.hasRequirements) {
      lines.push("  规则要求已全部满足");
    } else {
      lines.push("  未配置规则要求");
    }
    lines.push(
      `  建议：${
        result.action === "approve"
          ? "通过"
          : result.action === "reject"
            ? "拒绝"
            : "人工核实"
      }`,
    );
    lines.push(`  原始回答：${truncate(answer, 200)}`);
    return lines.join("\n");
  }
}

/** 名单条目比较：去空白、忽略大小写。 */
function sameText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** 年级比较：班级库存四位（`2022`）、规则面板存两位（`22`），两者视为同一年级。 */
function sameYear(left: string, right: string): boolean {
  const digits = (value: string): string => value.replace(/\D/gu, "");
  const a = digits(left);
  const b = digits(right);
  if (a.length >= 2 && b.length >= 2) {
    return a.slice(-2) === b.slice(-2);
  }
  return left.trim() === right.trim();
}

function truncate(text: string, max: number): string {  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

/**
 * 用群配置的入群规则字段评估一次申请。
 *
 * `/pending` 审核意见与推送卡片共用这段映射，避免两处参数写歪。
 */
export function evaluateConfiguredJoinRules(
  evaluator: JoinRuleEvaluator,
  config: EffectiveGroupConfig,
  answer: string,
  opinionEnabled = true,
): JoinEvaluation {
  return evaluator.evaluate(answer, {
    mode: config.joinDecision,
    requireClass: config.joinRequireClass,
    requireName: config.joinRequireName,
    answerPattern: config.joinAnswerPattern,
    allowColleges: config.allowColleges,
    denyColleges: config.denyColleges,
    allowYears: config.allowYears,
    denyYears: config.denyYears,
    opinionEnabled,
  });
}
