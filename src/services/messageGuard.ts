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
import { renderCard } from "./cardTemplate.js";
import type { AuditLog } from "./audit.js";
import { AuditLogStore } from "./audit.js";
import type { EffectiveGroupConfig } from "./groupConfig.js";
import { GroupConfigStore } from "./groupConfig.js";
import { RuleEngine } from "./moderation.js";
import type { PermissionService } from "./permissions.js";
import type { RichMessageSender } from "./richMessages.js";

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
    /** 注入后：审核员及以上（canReviewContent）的消息豁免关键词判断。 */
    private readonly permissions?: PermissionService,
    /**
     * 富消息发送器：注入后命中关键词会回一张**完整卡片**（@ 当事人 + 命中规则 + 处理动作）。
     * 未注入时退化为原来的纯文本警告（被动回复群消息）。
     */
    private readonly richMessages?: RichMessageSender,
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

    // 审核员及以上豁免关键词判断：不警告、不撤回、不处罚，也不写审计，只记 debug
    if (this.permissions?.canReviewContent(message.userId, message.groupId)) {
      log.debug("moderation exempt", {
        groupId: message.groupId,
        userId: message.userId,
        level: this.permissions.levelFor(message.userId, message.groupId),
      });
      return this.result(message, ModerationAction.Allow, [], false, "exempt");
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
    const [executed, detail] = await this.execute(action, message, config, matches);
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
    matches: readonly RuleMatch[],
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
          this.sendWarning(message, config, {
            recall,
            punish,
            muteDurationSeconds: config.muteDurationSeconds,
            matches,
          }),
        ),
      );
    }

    const executed = details.some((detail) => !detail.endsWith("_failed"));
    return [executed, details.length > 0 ? details.join("+") : "allow"];
  }

  /**
   * 命中反馈：注入富消息发送器时回一张**完整卡片**——
   * 首行 @ 当事人（卡片内 `<@!openid>` 已真机验证能 @ 到人），正文含命中规则、处理动作与群规则文案；
   * 没有发送器时退化为原来的纯文本警告。
   */
  private async sendWarning(
    message: IncomingMessage,
    config: EffectiveGroupConfig,
    input: {
      recall: boolean;
      punish: KeywordPunish;
      muteDurationSeconds: number;
      matches: readonly RuleMatch[];
    },
  ): Promise<void> {
    const hit = input.matches[0]?.reason?.trim();
    if (!this.richMessages) {
      await this.api.sendGroupMessage(
        message.groupId,
        config.warningMessage,
        message.messageId,
      );
      return;
    }
    const card = renderCard({
      title: "关键词命中",
      lines: [
        `<@!${message.userId}>`,
        `**命中规则**：${hit && hit.length > 0 ? hit : "（关键词）"}`,
        `**处理**：${this.punishLabel(input)}`,
        `**群规则**：${config.warningMessage}`,
      ],
      footer: ["有异议请联系群管理员；/help 查看全部指令"],
    });
    await this.richMessages.replyToGroup(message.groupId, card, {
      msgId: message.messageId,
    });
  }

  /** 把实际执行的动作写成一行中文（与 `execute` 的分支保持一致）。 */
  private punishLabel(input: {
    recall: boolean;
    punish: KeywordPunish;
    muteDurationSeconds: number;
  }): string {
    const parts: string[] = [];
    if (input.recall) {
      parts.push("撤回消息");
    }
    if (input.punish === KeywordPunish.Mute) {
      parts.push(`禁言 ${input.muteDurationSeconds} 秒`);
    } else if (input.punish === KeywordPunish.Kick) {
      parts.push("移出群");
    } else if (input.punish === KeywordPunish.KickBlacklist) {
      parts.push("移出并拉黑");
    }
    if (parts.length === 0) {
      parts.push("仅警告");
    }
    return parts.join(" + ");
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
