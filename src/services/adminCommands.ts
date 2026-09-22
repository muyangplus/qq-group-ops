import type { GroupConfigStore } from "./groupConfig.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { PermissionService } from "./permissions.js";

const HELP_TEXT = `可用指令：
/pending - 查看待审批入群申请
/approve <申请ID> - 通过入群申请
/reject <申请ID> [原因] - 拒绝入群申请
/rules - 查看当前群规则配置
/status - 查看当前群运行状态
/test - 测试机器人是否正常响应
/help - 显示帮助`;

export interface CommandResult {
  ok: boolean;
  text: string;
}

export class AdminCommandService {
  public constructor(
    private readonly permissions: PermissionService,
    private readonly joinAudit: JoinAuditService,
    private readonly configStore: GroupConfigStore,
  ) {}

  public handle(groupId: string, userId: string, text: string): CommandResult {
    const parts = text.trim().split(/\s+/u).filter((part) => part.length > 0);
    if (parts.length === 0) {
      return { ok: false, text: HELP_TEXT };
    }
    const command = parts[0]!.replace(/^\//u, "").toLowerCase();
    switch (command) {
      case "help":
      case "帮助":
        return { ok: true, text: HELP_TEXT };
      case "pending":
      case "待审批":
        return this.handlePending(groupId, userId);
      case "approve":
      case "通过":
        return this.handleApprove(groupId, userId, parts);
      case "reject":
      case "拒绝":
        return this.handleReject(groupId, userId, parts);
      case "rules":
      case "规则":
        return this.handleRules(groupId, userId);
      case "status":
      case "状态":
        return this.handleStatus(groupId, userId);
      case "test":
      case "测试":
        return this.handleTest(groupId, userId);
      default:
        return { ok: false, text: `未知指令：${parts[0]}\n\n${HELP_TEXT}` };
    }
  }

  private handlePending(groupId: string, userId: string): CommandResult {
    if (!this.permissions.canReviewContent(userId, groupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    const pending = this.joinAudit.pending(groupId);
    if (pending.length === 0) {
      return { ok: true, text: "当前没有待审批入群申请。" };
    }
    const lines = ["待审批入群申请："];
    pending.forEach((request, index) => {
      const reason = request.reason ? ` 理由：${request.reason}` : "";
      lines.push(`${index + 1}. ${request.requestId} 用户：${request.userId}${reason}`);
    });
    return { ok: true, text: lines.join("\n") };
  }

  private handleApprove(
    groupId: string,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.canApproveJoin(userId, groupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    const requestId = parts[1]?.trim();
    if (!requestId) {
      return { ok: false, text: "用法：/approve <申请ID>" };
    }
    try {
      this.joinAudit.approve(requestId, userId);
    } catch (error) {
      return { ok: false, text: `审批失败：${String(error)}` };
    }
    return { ok: true, text: `已通过入群申请 ${requestId}。` };
  }

  private handleReject(
    groupId: string,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.canApproveJoin(userId, groupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    const requestId = parts[1]?.trim();
    if (!requestId) {
      return { ok: false, text: "用法：/reject <申请ID> [原因]" };
    }
    const reason = parts.slice(2).join(" ").trim();
    try {
      this.joinAudit.reject(requestId, userId, reason);
    } catch (error) {
      return { ok: false, text: `审批失败：${String(error)}` };
    }
    return { ok: true, text: `已拒绝入群申请 ${requestId}。` };
  }

  private handleRules(groupId: string, userId: string): CommandResult {
    if (!this.permissions.canReviewContent(userId, groupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    const config = this.configStore.get(groupId);
    const keywords = config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）";
    return {
      ok: true,
      text: [
        `群 ${groupId} 规则配置：`,
        `启用：${config.enabled}`,
        `关键词过滤：${config.wordFilterEnabled}`,
        `关键词：${keywords}`,
        `入群审核：${config.joinAuditEnabled}`,
        `自动通过：${config.autoApproveJoin}`,
      ].join("\n"),
    };
  }

  private handleStatus(groupId: string, userId: string): CommandResult {
    if (!this.permissions.canReviewContent(userId, groupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    const config = this.configStore.get(groupId);
    return {
      ok: true,
      text: [
        `群 ${groupId} 状态：`,
        `机器人启用：${config.enabled}`,
        `消息过滤：${config.wordFilterEnabled}`,
        `入群审核：${config.joinAuditEnabled}`,
        `导出功能：${config.exportEnabled}`,
        `禁言时长：${config.muteDurationSeconds} 秒`,
      ].join("\n"),
    };
  }

  private handleTest(groupId: string, userId: string): CommandResult {
    if (!this.permissions.canReviewContent(userId, groupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    return {
      ok: true,
      text: [
        "测试成功：机器人已响应。",
        `群 ID：${groupId}`,
        `用户 ID：${userId}`,
        `待审批申请：${this.joinAudit.pending(groupId).length}`,
      ].join("\n"),
    };
  }
}
