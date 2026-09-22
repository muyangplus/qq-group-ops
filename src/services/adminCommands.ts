import { getLogger } from "../core/logger.js";
import type { GroupConfigStore } from "./groupConfig.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { PermissionService } from "./permissions.js";

const log = getLogger("admin-commands");

const HELP_TEXT = `可用指令：
/myid - 查询自己的 userId
/myperm - 查看自己的权限
/perm list - 查看权限配置（超管）
/perm grant super|admin|mod <userId> - 授予权限（超管）
/perm revoke super|admin|mod <userId> - 撤销权限（超管）
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
    log.debug("command", { groupId, userId, command });
    switch (command) {
      case "help":
      case "帮助":
        return { ok: true, text: HELP_TEXT };
      case "myid":
      case "我的id":
        return this.handleMyId(groupId, userId);
      case "myperm":
      case "我的权限":
        return this.handleMyPermission(groupId, userId);
      case "perm":
      case "权限":
        return this.handlePermissionConfig(groupId, userId, parts);
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

  private handleMyId(groupId: string, userId: string): CommandResult {
    return {
      ok: true,
      text: [
        `你的 userId：${userId}`,
        `当前群 ID：${groupId}`,
      ].join("\n"),
    };
  }

  private handleMyPermission(groupId: string, userId: string): CommandResult {
    const level = this.permissions.levelFor(userId, groupId);
    return {
      ok: true,
      text: [
        `你的权限等级：${level}`,
        `审核入群：${this.permissions.canApproveJoin(userId, groupId)}`,
        `管理规则：${this.permissions.canManageRules(userId, groupId)}`,
        `内容审核：${this.permissions.canReviewContent(userId, groupId)}`,
        `导出数据：${this.permissions.canExportData(userId, groupId)}`,
        `配置权限：${this.permissions.isSuperAdmin(userId)}`,
      ].join("\n"),
    };
  }

  private handlePermissionConfig(
    groupId: string,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      log.warn("permission config denied", { groupId, userId });
      return { ok: false, text: "权限不足：仅超级管理员可以配置权限。" };
    }

    const action = normalize(parts[1]);
    if (!action || action === "list" || action === "列表") {
      return {
        ok: true,
        text: this.formatPermissionList(groupId),
      };
    }

    const role = normalize(parts[2]);
    const targetUserId = parts[3]?.trim();
    if (!role || !targetUserId) {
      return {
        ok: false,
        text: "用法：/perm grant|revoke super|admin|mod <QQ>",
      };
    }

    try {
      if (action === "grant" || action === "授予") {
        this.grantRole(groupId, role, targetUserId);
      } else if (action === "revoke" || action === "撤销") {
        this.revokeRole(groupId, role, targetUserId);
      } else {
        return {
          ok: false,
          text: "用法：/perm grant|revoke super|admin|mod <QQ>",
        };
      }
    } catch (error) {
      log.warn("permission config failed", {
        groupId,
        userId,
        action,
        role,
        targetUserId,
        error: String(error),
      });
      return { ok: false, text: `权限配置失败：${String(error)}` };
    }

    log.info("permission config updated", {
      groupId,
      userId,
      action,
      role,
      targetUserId,
    });
    return {
      ok: true,
      text: `已更新权限：${role} ${targetUserId}\n\n${this.formatPermissionList(groupId)}`,
    };
  }

  private formatPermissionList(groupId: string): string {
    return [
      `权限配置（群 ${groupId}）：`,
      `超级管理员：${formatList(this.permissions.listSuperAdmins())}`,
      `群管理员：${formatList(this.permissions.listGroupAdmins(groupId))}`,
      `审核员：${formatList(this.permissions.listModerators(groupId))}`,
    ].join("\n");
  }

  private grantRole(groupId: string, role: string, targetUserId: string): void {
    if (role === "super" || role === "超管") {
      this.permissions.grantSuperAdmin(targetUserId);
      return;
    }
    if (role === "admin" || role === "管理员") {
      this.permissions.grantGroupAdmin(groupId, targetUserId);
      return;
    }
    if (role === "mod" || role === "审核员") {
      this.permissions.grantModerator(groupId, targetUserId);
      return;
    }
    throw new Error(`未知角色：${role}`);
  }

  private revokeRole(groupId: string, role: string, targetUserId: string): void {
    if (role === "super" || role === "超管") {
      this.permissions.revokeSuperAdmin(targetUserId);
      return;
    }
    if (role === "admin" || role === "管理员") {
      this.permissions.revokeGroupAdmin(groupId, targetUserId);
      return;
    }
    if (role === "mod" || role === "审核员") {
      this.permissions.revokeModerator(groupId, targetUserId);
      return;
    }
    throw new Error(`未知角色：${role}`);
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
      log.warn("approve failed", { requestId, error: String(error) });
      return { ok: false, text: `审批失败：${String(error)}` };
    }
    log.info("approved join request", { requestId, userId });
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
      log.warn("reject failed", { requestId, error: String(error) });
      return { ok: false, text: `审批失败：${String(error)}` };
    }
    log.info("rejected join request", { requestId, userId, hasReason: reason.length > 0 });
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
      log.warn("test permission denied", { groupId, userId });
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    log.info("test command", { groupId, userId });
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

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "（空）";
}
