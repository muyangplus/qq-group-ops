import { randomUUID } from "node:crypto";

import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import {
  AuditStatus,
  KeywordPunish,
  ModerationAction,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type {
  AuditRecord,
  IncomingMessage,
  RuleMatch,
} from "../core/models.js";
import { utcNow } from "../core/models.js";
import type { AuditLog } from "./audit.js";
import { AuditLogStore } from "./audit.js";
import type { EffectiveGroupConfig } from "./groupConfig.js";
import { GroupConfigStore } from "./groupConfig.js";
import { RuleEngine } from "./moderation.js";

const log = getLogger("message-guard");

export interface MessageGuardResult {
  groupId: string;
  userId: string;
  messageId: string;
  action: ModerationAction;
  matches: readonly RuleMatch[];
  executed: boolean;
  detail: string;
}

export class MessageGuardService {
  private readonly auditLog: AuditLog;
  /** 按群缓存的规则引擎，避免每条消息都重建；关键词变化时自动失效。 */
  private readonly engines = new Map<
    string,
    { keywordsKey: string; engine: RuleEngine }
  >();

  public constructor(
    private readonly api: QQOfficialAPI,
    private readonly rules: RuleEngine,
    private readonly configStore: GroupConfigStore,
    auditLog: AuditLog = new AuditLogStore(),
  ) {
    this.auditLog = auditLog;
  }

  /**
   * 群配置里的关键词会转换成规则，与静态规则合并后用于本群。
   * 关键词命中默认动作是警告，内容取该群的 warningMessage。
   */
  private engineFor(config: EffectiveGroupConfig): RuleEngine {
    const keywordsKey = config.keywords.join("\u0000");
    const cached = this.engines.get(config.groupId);
    if (cached && cached.keywordsKey === keywordsKey) {
      return cached.engine;
    }
    const keywordEngine = RuleEngine.fromKeywords(config.keywords);
    const engine = new RuleEngine([...this.rules.rules, ...keywordEngine.rules]);
    this.engines.set(config.groupId, { keywordsKey, engine });
    return engine;
  }

  public async handleMessage(message: IncomingMessage): Promise<MessageGuardResult> {
    const config = this.configStore.get(message.groupId);
    if (!config.enabled || !config.wordFilterEnabled) {
      log.debug("skipped", { groupId: message.groupId, reason: "disabled" });
      return this.result(message, ModerationAction.Allow, [], false, "disabled");
    }

    const engine = this.engineFor(config);
    const matches = engine.evaluate(message.content);
    if (matches.length === 0) {
      return this.result(message, ModerationAction.Allow, [], false, "no_match");
    }

    const action = engine.highestAction(message.content);
    log.info("rule matched", {
      groupId: message.groupId,
      userId: message.userId,
      action,
      rules: matches.map((match) => match.ruleId),
    });
    const [executed, detail] = await this.execute(action, message, config);
    const record: AuditRecord = {
      recordId: randomUUID(),
      groupId: message.groupId,
      actorId: "bot",
      targetUserId: message.userId,
      action: `moderation:${action}`,
      status: executed ? AuditStatus.Executed : AuditStatus.Pending,
      reason: matches[0]?.reason ?? "",
      createdAt: utcNow(),
    };
    this.auditLog.append(record);
    return this.result(message, action, matches, executed, detail);
  }

  private async execute(
    action: ModerationAction,
    message: IncomingMessage,
    config: EffectiveGroupConfig,
  ): Promise<[boolean, string]> {
    if (action === ModerationAction.Review) {
      return [false, "queued_for_review"];
    }

    // 群配置可以额外要求撤回，并指定处罚动作；规则自带的动作仍然生效
    const recall = config.keywordRecall || action === ModerationAction.Recall;
    const punish =
      config.keywordPunish !== KeywordPunish.None
        ? config.keywordPunish
        : action === ModerationAction.Mute
          ? KeywordPunish.Mute
          : action === ModerationAction.Kick
            ? KeywordPunish.Kick
            : KeywordPunish.None;
    const warn =
      action === ModerationAction.Warn ||
      recall ||
      punish !== KeywordPunish.None;

    log.debug("execute action", {
      action,
      groupId: message.groupId,
      recall,
      punish,
      warn,
    });

    const details: string[] = [];
    if (recall) {
      details.push(
        await this.attempt("recall", () =>
          this.api.recallGroupMessage(message.groupId, message.messageId),
        ),
      );
    }
    if (punish === KeywordPunish.Mute) {
      details.push(
        await this.attempt("mute", () =>
          this.api.muteGroupMember(
            message.groupId,
            message.userId,
            config.muteDurationSeconds,
          ),
        ),
      );
    }
    if (punish === KeywordPunish.Kick) {
      details.push(
        await this.attempt("remove", () =>
          this.api.removeGroupMember(message.groupId, message.userId),
        ),
      );
    }
    if (punish === KeywordPunish.KickBlacklist) {
      details.push(
        await this.attempt("remove+blacklist", () =>
          this.api.removeGroupMember(message.groupId, message.userId, {
            addToMemberBlacklist: true,
          }),
        ),
      );
    }
    if (warn) {
      details.push(
        await this.attempt("warn", () =>
          this.api.sendGroupMessage(
            message.groupId,
            config.warningMessage,
            message.messageId,
          ),
        ),
      );
    }

    const executed = details.some((detail) => !detail.endsWith("_failed"));
    return [executed, details.length > 0 ? details.join("+") : "allow"];
  }

  /** 单个动作失败不影响其他动作与审计记录，失败信息带 `_failed` 后缀。 */
  private async attempt(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<string> {
    try {
      await action();
      return label;
    } catch (error) {
      log.warn("moderation action failed", {
        action: label,
        error: error instanceof Error ? error.message : String(error),
      });
      return `${label}_failed`;
    }
  }

  private result(
    message: IncomingMessage,
    action: ModerationAction,
    matches: readonly RuleMatch[],
    executed: boolean,
    detail: string,
  ): MessageGuardResult {
    return {
      groupId: message.groupId,
      userId: message.userId,
      messageId: message.messageId,
      action,
      matches,
      executed,
      detail,
    };
  }
}
