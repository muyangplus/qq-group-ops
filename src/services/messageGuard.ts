import { randomUUID } from "node:crypto";

import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import {
  AuditStatus,
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
    log.debug("execute action", { action, groupId: message.groupId });
    switch (action) {
      case ModerationAction.Warn:
        await this.api.sendGroupMessage(message.groupId, config.warningMessage, message.messageId);
        return [true, "warned"];
      case ModerationAction.Recall:
        await this.api.recallGroupMessage(message.groupId, message.messageId);
        return [true, "recalled"];
      case ModerationAction.Mute:
        await this.api.muteGroupMember(
          message.groupId,
          message.userId,
          config.muteDurationSeconds,
        );
        return [true, "muted"];
      case ModerationAction.Kick:
        await this.api.removeGroupMember(message.groupId, message.userId);
        return [true, "removed"];
      case ModerationAction.Review:
        return [false, "queued_for_review"];
      case ModerationAction.Allow:
        return [false, "allow"];
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
