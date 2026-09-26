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
import { encodeCallback } from "./callbackData.js";
import { renderCard, singleLine } from "./cardTemplate.js";
import type { AuditLog } from "./audit.js";
import { AuditLogStore } from "./audit.js";
import type { EffectiveGroupConfig } from "./groupConfig.js";
import { GroupConfigStore } from "./groupConfig.js";
import { RuleEngine } from "./moderation.js";
import type { PermissionService } from "./permissions.js";
import type { PunishmentService } from "./punishments.js";
import type { BlacklistService } from "./blacklist.js";
import type { RichMessageSender } from "./richMessages.js";

const log = getLogger("message-guard");

/** 处罚原文的最大长度（§B7：只留够审核员判断的片段，少存一点隐私）。 */
export const RAW_MESSAGE_EXCERPT_MAX = 200;

/**
 * 处罚记录里保存的消息原文：压成单行 + 截断。
 *
 * 只有本群 `rawMessageRetentionDays > 0` 时才调用（默认不保存原文，见 ADR-0005）。
 */
export function rawMessageExcerpt(content: string): string {
  return singleLine(content).slice(0, RAW_MESSAGE_EXCERPT_MAX);
}

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
     * 富消息发送器：注入后命中关键词会回一张**「处罚通知」卡片**（@ 当事人 + 处理动作 + 群规则文案；
     * 不写命中的具体规则，也不带消息原文 —— 见 `sendWarning`）。
     * 未注入时退化为原来的纯文本警告（被动回复群消息）。
     */
    private readonly richMessages?: RichMessageSender,
    /**
     * 处罚记录服务（§B7）：注入后会记录每次实际处罚，并推送给「处罚通知」的订阅者，
     * 卡片上可直接调整处罚；群内警告卡也会多一个「我要申诉」按钮（§B8）。
     */
    private readonly punishments?: PunishmentService,
    /**
     * 黑名单服务（§A5 / §B2）：勾选「拉黑」时落本地黑名单（入群审批最高优先级拒绝）
     * 并尝试官方群拉黑；`kick: false` 表示**不自动踢人**，官方接口失败只记日志。
     */
    private readonly blacklist?: BlacklistService,
  ) {
    this.auditLog = auditLog;
  }

  /**
   * 群配置里的关键词会转换成规则，与静态规则合并后用于本群。
   * 关键词命中默认动作是警告，内容取该群的 warningMessage。
   */
  private engineFor(config: EffectiveGroupConfig): RuleEngine {
    // 缓存键必须同时覆盖关键词与正则（§B1）
    const keywordsKey = `${config.keywords.join("\u0000")}\u0001${config.regexRules.join("\u0000")}`;
    const cached = this.engines.get(config.groupId);
    if (cached && cached.keywordsKey === keywordsKey) {
      return cached.engine;
    }
    const keywordEngine = RuleEngine.fromKeywords(config.keywords);
    const regexEngine = RuleEngine.fromRegex(config.regexRules);
    const engine = new RuleEngine([
      ...this.rules.rules,
      ...keywordEngine.rules,
      ...regexEngine.rules,
    ]);
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

    // §B1 用户白名单：名单内用户与审核员一样豁免关键词 / 正则判断（不警告、不撤回、不处罚、不写审计）
    if (config.userWhitelist.includes(message.userId)) {
      log.debug("moderation whitelist exemption", {
        groupId: message.groupId,
        userId: message.userId,
      });
      return this.result(message, ModerationAction.Allow, [], false, "whitelisted");
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
    const plan = this.planFor(action, config);
    // §B7：先建处罚记录（拿到短码），执行后再回填结果并推送审核员。
    // 只有真的有处置动作（撤回 / 禁言 / 踢出 / 拉黑）才记录；纯警告没有可撤销的动作。
    const punishment =
      this.punishments &&
      (plan.recall || plan.mute || plan.kick || plan.blacklist)
        ? await this.punishments.create({
            groupId: message.groupId,
            userId: message.userId,
            actorId: "bot",
            source: "keyword",
            ruleReason: matches[0]?.reason ?? "",
            messageId: message.messageId,
            // §B7：只有本群开启了消息保留才落库原文（默认不保存，隐私优先）。
            ...(config.rawMessageRetentionDays > 0
              ? { messageExcerpt: rawMessageExcerpt(message.content) }
              : {}),
            actions: {
              recalled: plan.recall,
              muted: plan.mute,
              muteDurationSeconds: plan.mute ? config.muteDurationSeconds : 0,
              kicked: plan.kick,
              blacklist: plan.blacklist ? "group" : "",
            },
          })
        : undefined;
    const [executed, detail] = await this.execute(
      plan,
      message,
      config,
      matches,
      punishment?.recordId,
    );
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
    if (punishment) {
      await this.punishments?.markExecuted(punishment.recordId, detail);
    }
    return this.result(message, action, matches, executed, detail);
  }

  /** 把规则动作 + 群配置折成一份执行计划（记录与执行共用，避免两处判断分叉）。 */
  private planFor(
    action: ModerationAction,
    config: EffectiveGroupConfig,
  ): {
    action: ModerationAction;
    /** 五个动作互相独立（§B2 多选重构）：撤回 → 禁言 → 踢出 → 拉黑 → 警告。 */
    recall: boolean;
    mute: boolean;
    kick: boolean;
    blacklist: boolean;
    warn: boolean;
    muteDurationSeconds: number;
  } {
    const configured = config.punishActions;
    // 规则本身带来的动作（静态规则可以自带 Mute / Kick / Recall）与群配置取并集
    const recall = configured.recall || action === ModerationAction.Recall;
    const mute = configured.mute || action === ModerationAction.Mute;
    const kick = configured.kick || action === ModerationAction.Kick;
    const blacklist = configured.blacklist;
    // 有任何一个处置动作就发警告卡；只勾「警告」时也发
    const warn = configured.warn || recall || mute || kick || blacklist;
    return {
      action,
      recall,
      mute,
      kick,
      blacklist,
      warn,
      muteDurationSeconds: config.muteDurationSeconds,
    };
  }

  private async execute(
    plan: {
      action: ModerationAction;
      recall: boolean;
      mute: boolean;
      kick: boolean;
      blacklist: boolean;
      warn: boolean;
      muteDurationSeconds: number;
    },
    message: IncomingMessage,
    config: EffectiveGroupConfig,
    matches: readonly RuleMatch[],
    punishmentCode?: string,
  ): Promise<[boolean, string]> {
    if (plan.action === ModerationAction.Review) {
      return [false, "queued_for_review"];
    }

    const { recall, mute, kick, blacklist, warn } = plan;
    const muteDurationSeconds = plan.muteDurationSeconds;

    log.debug("execute action", {
      action: plan.action,
      groupId: message.groupId,
      recall,
      mute,
      kick,
      blacklist,
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
    if (mute) {
      details.push(
        await this.attempt("mute", () =>
          this.api.muteGroupMember(
            message.groupId,
            message.userId,
            muteDurationSeconds,
          ),
        ),
      );
    }
    if (kick) {
      details.push(
        await this.attempt("remove", () =>
          this.api.removeGroupMember(message.groupId, message.userId),
        ),
      );
    }
    if (blacklist) {
      // §A5/§B2：拉黑**不自动踢人** —— 本地黑名单立即生效（入群审批最高优先级拒绝），
      // 再尝试官方群拉黑（官方要求目标不在群中，人在群里时会失败，只记日志）。
      details.push(
        await this.attempt("blacklist", () =>
          this.blacklist
            ? this.blacklist.add({
                scope: "group",
                groupId: message.groupId,
                userId: message.userId,
                actorId: "bot:auto",
                source: "keyword",
                reason: "命中群规则",
                kick: false,
              })
            : Promise.reject(new Error("blacklist service unavailable")),
        ),
      );
    }
    if (warn) {
      details.push(
        await this.attempt("warn", () =>
          this.sendWarning(message, config, {
            recall,
            mute,
            kick,
            blacklist,
            muteDurationSeconds,
            matches,
            ...(punishmentCode !== undefined ? { punishmentCode } : {}),
          }),
        ),
      );
    }

    const executed = details.some((detail) => !detail.endsWith("_failed"));
    return [executed, details.length > 0 ? details.join("+") : "allow"];
  }

  /**
   * 命中反馈：注入富消息发送器时回一张**完整卡片**——
   * 首行 @ 当事人（卡片内 `<@!openid>` 已真机验证能 @ 到人），正文是处理动作与群规则文案。
   *
   * §隐私口径（2026-09-26 用户确认）：
   * - **不写命中的具体规则**（关键词 / 正则都算隐私，写了等于把规则内容贴到群里）；
   * - **不带消息原文**（群里任何人可见）；
   * - 卡片标题就叫「处罚通知」。
   * 具体规则与原文只出现在**私信**卡片里（审核员与当事人本人）。
   *
   * 没有发送器时退化为原来的纯文本警告（只发群规则文案）。
   */
  private async sendWarning(
    message: IncomingMessage,
    config: EffectiveGroupConfig,
    input: {
      recall: boolean;
      mute: boolean;
      kick: boolean;
      blacklist: boolean;
      muteDurationSeconds: number;
      matches: readonly RuleMatch[];
      /** §B8：处罚记录短码；有值时卡片带「我要申诉」按钮（只有当事人能点）。 */
      punishmentCode?: string | undefined;
    },
  ): Promise<void> {
    if (!this.richMessages) {
      await this.api.sendGroupMessage(
        message.groupId,
        config.warningMessage,
        message.messageId,
      );
      return;
    }
    const card = renderCard({
      title: "处罚通知",
      lines: [
        `<@!${message.userId}>`,
        `**处理**：${this.punishLabel(input)}`,
        `**群规则**：${config.warningMessage}`,
      ],
      ...(input.punishmentCode
        ? {
            rows: [
              [
                {
                  id: "appeal",
                  label: "我要申诉",
                  style: 1 as const,
                  callbackData: encodeCallback(
                    "appeal",
                    "new",
                    input.punishmentCode,
                  ),
                  permission: {
                    type: 0 as const,
                    specifyUserIds: [message.userId],
                  },
                  unsupportTips: "当前 QQ 版本不支持按钮，请私聊机器人再试",
                },
              ],
            ],
            // §B8 真机结论：成员**被禁言时无法在群里点任何按钮**（客户端直接拦），
            // 所以群里那张卡必须同时给出「私聊机器人」的申诉入口，否则当事人无路可走。
            footer: [
              `点击下方按钮或私聊机器人发送  /appeal #${input.punishmentCode} <理由>  即可申诉`,
            ],
          }
        : {}),
    });
    await this.richMessages.replyToGroup(message.groupId, card, {
      msgId: message.messageId,
    });
  }

  /** 把实际执行的动作写成一行中文（与 `execute` 的分支保持一致）。 */
  private punishLabel(input: {
    recall: boolean;
    mute: boolean;
    kick: boolean;
    blacklist: boolean;
    muteDurationSeconds: number;
  }): string {
    const parts: string[] = [];
    if (input.recall) {
      parts.push("撤回消息");
    }
    if (input.mute) {
      parts.push(`禁言 ${input.muteDurationSeconds} 秒`);
    }
    if (input.kick) {
      parts.push("移出群");
    }
    if (input.blacklist) {
      parts.push("拉黑（本群）");
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
