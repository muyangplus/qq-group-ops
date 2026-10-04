import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { JoinDecisionMode, JoinRequestStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { BlacklistService } from "./blacklist.js";
import type { GroupConfigStore } from "./groupConfig.js";
import type { JoinRuleEvaluator } from "./joinRules.js";
import type { JoinAuditService, JoinRequest } from "./joinAudit.js";

const log = getLogger("join-approval");

/** 黑名单自动拒绝的审核人标记（审计里可区分于规则引擎）。 */
const BLACKLIST_ACTOR = "bot:blacklist";

/** 官方已经处理过这条申请时，本地移出待审批的审计理由。 */
export const ALREADY_HANDLED_REASON =
  "官方侧提示该申请已被处理（其它管理员 / 群管理后台），自动移出待审批";

/** 给操作者看的人话（审批/拒绝都会带这个前缀：审批失败：…）。 */
export const ALREADY_HANDLED_MESSAGE =
  "这条申请在 QQ 那边已经处理过了（可能是其它管理员或群管理后台），已从待审批里移除。";

/**
 * 官方是不是在说「这条申请已经被处理了」。
 *
 * 真机原文：`QQ official API error 400: 申请已经被处理` —— 说明这条申请在群管理后台
 * （或别的机器人）已经被通过 / 拒绝，官方那边已经没有它了；本地**不能**再把它留在待审批里
 * （否则每条都点一下报一次错、还占着「待审批 N 条」）。
 *
 * 判据用**消息文本**（官方没给稳定 error code）：只认「已经处理 / 已被处理 / 不存在」这类
 * 明确的终态措辞 —— 不能宽到把限流、超时、权限错误也当成「处理过了」。
 */
export function isAlreadyHandledError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (text.length === 0) {
    return false;
  }
  return /已经被处理|已被处理|已经处理过|已被审批|申请不存在|不存在该申请|请求不存在/u.test(
    text,
  );
}

/**
 * 入群审批。
 *
 * 顺序很重要：先调用官方审批接口，成功后再更新本地状态与审计记录。
 * 否则会出现「机器人显示已通过、但群里其实没通过」的不一致。
 */
export class JoinApprovalService {
  public constructor(
    private readonly api: QQOfficialAPI,
    private readonly joinAudit: JoinAuditService,
    private readonly configStore: GroupConfigStore,
    private readonly joinRules?: JoinRuleEvaluator,
    /** 黑名单（§A5）：命中即**最高优先级**直接拒绝，先于一切入群规则。 */
    private readonly blacklist?: BlacklistService,
  ) {}

  /**
   * 按群配置的入群规则自动决策；无法确定时保持人工审核。
   *
   * 决策一律「先官方、后本地」：官方接口失败时申请保持待审批。
   *
   * 返回值里的 `notify` 表示是否要推送给审核员：
   * - 需要人工处理（`manual`）→ 总是推送；
   * - 机器人自动通过/拒绝 → 只有群配置 `notifyAutoApproved` 开启时才推送（告知结果）。
   */
  public async applyJoinRules(
    groupId: string,
    requestId: string,
  ): Promise<{
    action: "approve" | "reject" | "manual";
    opinion: string;
    notify: boolean;
  }> {
    const request = this.joinAudit.get(requestId);
    const config = this.configStore.get(groupId);
    const notifyAuto = config.notifyAutoApproved;

    // §A5 黑名单是**最高优先级**：命中即拒绝，先于开关判断、joinDecision、名单/班级规则。
    // 官方接口失败时退回人工审核，避免「机器人以为拒绝了、官方那边还挂着」。
    const blacklisted = this.blacklist?.hitFor(groupId, request.userId);
    if (blacklisted) {
      const reason =
        blacklisted.scope === "global"
          ? "申请人在全局黑名单中。"
          : "申请人在本群黑名单中。";
      try {
        await this.api.approveJoinRequest(groupId, request.userId, false, {
          joinRequestId: requestId,
          reason,
        });
        this.joinAudit.reject(requestId, BLACKLIST_ACTOR, reason);
        log.info("join request auto rejected by blacklist", {
          groupId,
          requestId,
          scope: blacklisted.scope,
        });
        return { action: "reject", opinion: reason, notify: notifyAuto };
      } catch (error) {
        // 官方说「已经被处理」→ 本地立即移出待审批，并如实说明（不是「保持人工审核」）
        if (isAlreadyHandledError(error)) {
          this.dropAlreadyHandled(requestId, groupId);
          return { action: "manual", opinion: ALREADY_HANDLED_MESSAGE, notify: false };
        }
        log.error("blacklist auto reject failed, keeping manual review", {
          groupId,
          requestId,
          scope: blacklisted.scope,
          error: error instanceof Error ? error.message : String(error),
        });
        return { action: "manual", opinion: reason, notify: true };
      }
    }

    // 群关闭机器人或关闭入群审核时不自动决策
    if (!config.enabled || !config.joinAuditEnabled) {
      return { action: "manual", opinion: "", notify: true };
    }

    const mode =
      config.joinDecision !== JoinDecisionMode.Manual
        ? config.joinDecision
        : config.autoApproveJoin
          ? JoinDecisionMode.AutoApprove
          : JoinDecisionMode.Manual;

    // 纯自动通过不需要规则评估器；按规则决策则需要
    if (mode === JoinDecisionMode.Manual) {
      return { action: "manual", opinion: "", notify: true };
    }
    if (mode !== JoinDecisionMode.AutoApprove && !this.joinRules) {
      return { action: "manual", opinion: "", notify: true };
    }

    const evaluation = this.joinRules?.evaluate(request.reason, {
      mode,
      requireClass: config.joinRequireClass,
      requireName: config.joinRequireName,
      answerPattern: config.joinAnswerPattern,
      allowColleges: config.allowColleges,
      denyColleges: config.denyColleges,
      allowYears: config.allowYears,
      denyYears: config.denyYears,
      opinionEnabled: config.joinReviewOpinion,
    }) ?? { action: "approve" as const, matched: true, opinion: "" };

    if (evaluation.action === "manual") {
      log.info("join request queued for manual review", {
        groupId,
        requestId,
        matched: evaluation.matched,
      });
      return { action: "manual", opinion: evaluation.opinion, notify: true };
    }

    const reviewerId = "bot:auto";
    try {
      if (evaluation.action === "approve") {
        await this.api.approveJoinRequest(groupId, request.userId, true, {
          joinRequestId: requestId,
        });
        this.joinAudit.approve(requestId, reviewerId);
        log.info("auto approved join request", { groupId, requestId, mode });
        return {
          action: "approve",
          opinion: evaluation.opinion,
          notify: notifyAuto,
        };
      }
      const reason = buildRejectReason(evaluation.opinion);
      await this.api.approveJoinRequest(groupId, request.userId, false, {
        joinRequestId: requestId,
        ...(reason ? { reason } : {}),
      });
      this.joinAudit.reject(requestId, reviewerId, reason);
      log.info("auto rejected join request", { groupId, requestId, mode });
      return {
        action: "reject",
        opinion: evaluation.opinion,
        notify: notifyAuto,
      };
    } catch (error) {
      // 已经被别处处理掉了：不必再推给审核员（推了也是点一下报错），本地顺手清掉
      if (isAlreadyHandledError(error)) {
        this.dropAlreadyHandled(requestId, groupId);
        return { action: "manual", opinion: ALREADY_HANDLED_MESSAGE, notify: false };
      }
      log.error("auto join decision failed, keeping manual review", {
        groupId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { action: "manual", opinion: evaluation.opinion, notify: true };
    }
  }

  public async approve(
    groupId: string,
    requestId: string,
    reviewerId: string,
    reason = "",
  ): Promise<JoinRequest> {
    const request = this.requireRequest(groupId, requestId);
    try {
      await this.api.approveJoinRequest(groupId, request.userId, true, {
        joinRequestId: requestId,
        ...(reason ? { reason } : {}),
      });
    } catch (error) {
      this.throwOrDropAlreadyHandled(error, groupId, requestId);
    }
    log.info("approved join request", { groupId, requestId, reviewerId });
    return this.joinAudit.approve(requestId, reviewerId);
  }

  public async reject(
    groupId: string,
    requestId: string,
    reviewerId: string,
    reason = "",
  ): Promise<JoinRequest> {
    const request = this.requireRequest(groupId, requestId);
    // 人工拒绝的理由是审核员手写的自由文本（`/reject <短码> <自定义理由>`）：
    // 压成单行并截断，避免长文/换行撑坏官方 `reject_reason`
    const normalizedReason = buildRejectReason(reason);
    try {
      await this.api.approveJoinRequest(groupId, request.userId, false, {
        joinRequestId: requestId,
        ...(normalizedReason ? { reason: normalizedReason } : {}),
      });
    } catch (error) {
      this.throwOrDropAlreadyHandled(error, groupId, requestId);
    }
    log.info("rejected join request", {
      groupId,
      requestId,
      reviewerId,
      hasReason: normalizedReason.length > 0,
    });
    return this.joinAudit.reject(requestId, reviewerId, normalizedReason);
  }

  /**
   * 官方返回「申请已经被处理」时：本地立即移出待审批（复用对账那条路径 + `expire_join_request`
   * 审计），然后**抛一条人话**给操作者；其它错误原样抛出（该申请保持待审批，可重试）。
   *
   * 为什么这里要抛：审批**确实没成功**（别人已经在官方那边定了结果），不能假装通过；
   * 但本地队列必须干净 —— 真机现象就是「每条申请点一下报一次 `400 申请已经被处理`，
   * 而它一直挂在待审批里没被自动删除」。
   */
  private throwOrDropAlreadyHandled(
    error: unknown,
    groupId: string,
    requestId: string,
  ): never {
    if (!isAlreadyHandledError(error)) {
      throw error;
    }
    this.dropAlreadyHandled(requestId, groupId);
    throw new Error(ALREADY_HANDLED_MESSAGE);
  }

  /** 把「官方已处理」的本地申请移出待审批（幂等；已经不是待审批就什么都不做）。 */
  private dropAlreadyHandled(requestId: string, groupId: string): void {
    const removed = this.joinAudit.markHandledExternally(
      requestId,
      ALREADY_HANDLED_REASON,
    );
    log.warn("official already handled this join request, removed from pending", {
      groupId,
      requestId,
      removed,
    });
  }

  private requireRequest(groupId: string, requestId: string): JoinRequest {
    const request = this.joinAudit.get(requestId);
    if (request.groupId !== groupId) {
      throw new Error("join request does not belong to this group");
    }
    if (request.status !== JoinRequestStatus.Pending) {
      throw new Error("join request already reviewed");
    }
    return request;
  }
}

/** 拒绝理由统一处理：压成单行（多行用「；」连接）并截断到 120 字；自动 / 人工两条路径共用。 */
function buildRejectReason(opinion: string): string {
  const compact = opinion
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("；");
  if (compact.length <= 120) {
    return compact;
  }
  return `${compact.slice(0, 120)}…`;
}
