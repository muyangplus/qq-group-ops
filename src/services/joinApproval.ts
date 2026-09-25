import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { JoinDecisionMode, JoinRequestStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { GroupConfigStore } from "./groupConfig.js";
import type { JoinRuleEvaluator } from "./joinRules.js";
import type { JoinAuditService, JoinRequest } from "./joinAudit.js";

const log = getLogger("join-approval");

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
    await this.api.approveJoinRequest(groupId, request.userId, true, {
      joinRequestId: requestId,
      ...(reason ? { reason } : {}),
    });
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
    await this.api.approveJoinRequest(groupId, request.userId, false, {
      joinRequestId: requestId,
      ...(reason ? { reason } : {}),
    });
    log.info("rejected join request", {
      groupId,
      requestId,
      reviewerId,
      hasReason: reason.length > 0,
    });
    return this.joinAudit.reject(requestId, reviewerId, reason);
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

/** 自动拒绝时把审核意见作为拒绝理由回传给官方（太长则截断）。 */
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
