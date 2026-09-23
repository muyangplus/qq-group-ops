import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { JoinRequestStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { GroupConfigStore } from "./groupConfig.js";
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
  ) {}

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

  /**
   * 群配置开启 autoApproveJoin 时自动通过申请。
   * 出错只记录日志，不影响入群申请本身进入待审批队列。
   */
  public async autoApproveIfEnabled(
    groupId: string,
    requestId: string,
  ): Promise<boolean> {
    const config = this.configStore.get(groupId);
    if (!config.enabled || !config.joinAuditEnabled || !config.autoApproveJoin) {
      return false;
    }
    const request = this.joinAudit.get(requestId);
    try {
      await this.api.approveJoinRequest(groupId, request.userId, true, {
        joinRequestId: requestId,
      });
    } catch (error) {
      log.error("auto approve failed", {
        groupId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    this.joinAudit.approve(requestId, "bot");
    log.info("auto approved join request", { groupId, requestId });
    return true;
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
