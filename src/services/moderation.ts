import {
  ModerationAction,
  RiskLevel,
} from "../core/enums.js";
import type { RuleMatch } from "../core/models.js";

const ACTION_PRIORITY: Record<ModerationAction, number> = {
  [ModerationAction.Allow]: 0,
  [ModerationAction.Warn]: 1,
  [ModerationAction.Review]: 2,
  [ModerationAction.Recall]: 3,
  [ModerationAction.Mute]: 4,
  [ModerationAction.Kick]: 5,
};

export interface ModerationRule {
  ruleId: string;
  pattern: string;
  action?: ModerationAction;
  reason?: string;
  risk?: RiskLevel;
  isRegex?: boolean;
  enabled?: boolean;
  caseSensitive?: boolean;
}

interface ResolvedRule {
  ruleId: string;
  pattern: string;
  action: ModerationAction;
  reason: string;
  risk: RiskLevel;
  isRegex: boolean;
  enabled: boolean;
  caseSensitive: boolean;
}

export class RuleEngine {
  private readonly resolvedRules: readonly ResolvedRule[];
  private readonly compiled = new Map<string, RegExp>();

  public constructor(rules: readonly ModerationRule[] = []) {
    this.resolvedRules = rules.map((rule) => ({
      ruleId: rule.ruleId,
      pattern: rule.pattern,
      action: rule.action ?? ModerationAction.Warn,
      reason: rule.reason ?? "命中规则",
      risk: rule.risk ?? RiskLevel.Medium,
      isRegex: rule.isRegex ?? false,
      enabled: rule.enabled ?? true,
      caseSensitive: rule.caseSensitive ?? false,
    }));

    for (const rule of this.resolvedRules) {
      if (!rule.isRegex) {
        continue;
      }
      try {
        this.compiled.set(
          rule.ruleId,
          new RegExp(rule.pattern, rule.caseSensitive ? "" : "i"),
        );
      } catch (error) {
        throw new Error(
          `invalid regex for rule ${JSON.stringify(rule.ruleId)}: ${JSON.stringify(rule.pattern)}`,
          { cause: error },
        );
      }
    }
  }

  public get rules(): readonly ResolvedRule[] {
    return this.resolvedRules;
  }

  public evaluate(content: string): RuleMatch[] {
    const matches: RuleMatch[] = [];
    for (const rule of this.resolvedRules) {
      if (!rule.enabled || !this.matches(rule, content)) {
        continue;
      }
      matches.push({
        ruleId: rule.ruleId,
        pattern: rule.pattern,
        action: rule.action,
        reason: rule.reason,
        risk: rule.risk,
      });
    }
    return matches;
  }

  public highestAction(content: string): ModerationAction {
    const matches = this.evaluate(content);
    if (matches.length === 0) {
      return ModerationAction.Allow;
    }
    return matches.reduce((highest, match) =>
      ACTION_PRIORITY[match.action] > ACTION_PRIORITY[highest.action] ? match : highest,
    ).action;
  }

  public static fromKeywords(
    keywords: readonly string[],
    options: { action?: ModerationAction; risk?: RiskLevel } = {},
  ): RuleEngine {
    return new RuleEngine(
      keywords
        .filter((keyword) => keyword.length > 0)
        .map((keyword) => ({
          ruleId: `keyword:${keyword}`,
          pattern: keyword,
          action: options.action ?? ModerationAction.Warn,
          reason: `命中关键词：${keyword}`,
          risk: options.risk ?? RiskLevel.Medium,
        })),
    );
  }

  /**
   * §B1：把群配置里的正则规则编译成规则集。
   *
   * 单条非法正则不会让整个引擎抛错（配置可能来自旧数据 / 手工改库），只跳过该条；
   * `/rules set|add regex` 在写入前已经用 `requireValidRegex` 校验过。
   */
  public static fromRegex(
    patterns: readonly string[],
    options: { action?: ModerationAction; risk?: RiskLevel } = {},
  ): RuleEngine {
    const valid: ModerationRule[] = [];
    for (const raw of patterns) {
      const pattern = raw.trim();
      if (pattern.length === 0) {
        continue;
      }
      try {
        new RegExp(pattern, "u");
      } catch {
        continue;
      }
      valid.push({
        ruleId: `regex:${pattern}`,
        pattern,
        action: options.action ?? ModerationAction.Warn,
        reason: `命中正则：${pattern}`,
        risk: options.risk ?? RiskLevel.Medium,
        isRegex: true,
      });
    }
    return new RuleEngine(valid);
  }

  private matches(rule: ResolvedRule, content: string): boolean {
    if (rule.isRegex) {
      return this.compiled.get(rule.ruleId)?.test(content) ?? false;
    }
    if (rule.caseSensitive) {
      return content.includes(rule.pattern);
    }
    return content.toLowerCase().includes(rule.pattern.toLowerCase());
  }
}
