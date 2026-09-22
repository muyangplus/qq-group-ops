import { getLogger } from "../core/logger.js";
import type { GroupConfigStore } from "./groupConfig.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { PermissionService } from "./permissions.js";

const log = getLogger("admin-commands");

const HELP_TEXT = `可用指令：
/myid - 查询自己的 userId
/myperm - 查看自己的权限
/perm list [group_openid] - 查看权限配置（超管）
/perm grant super <userId> - 授予全局超管（超管）
/perm revoke super <userId> - 撤销全局超管（超管）
/perm grant admin [group_openid] <userId> - 授予群管理员（超管）
/perm revoke admin [group_openid] <userId> - 撤销群管理员（超管）
/perm grant mod [group_openid] <userId> - 授予审核员（超管）
/perm revoke mod [group_openid] <userId> - 撤销审核员（超管）
/pending [group_openid] - 查看待审批入群申请
/approve [group_openid] <申请ID> - 通过入群申请
/reject [group_openid] <申请ID> [原因] - 拒绝入群申请
/rules [group_openid] - 查看群规则配置
/status [group_openid] - 查看群运行状态
/test - 测试机器人是否正常响应
/help - 显示帮助

说明：私信中执行群管理指令时，需要提供 group_openid。`;

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

  public handle(
    groupId: string | undefined,
    userId: string,
    text: string,
  ): CommandResult {
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
        return this.handlePending(groupId, userId, parts);
      case "approve":
      case "通过":
        return this.handleApprove(groupId, userId, parts);
      case "reject":
      case "拒绝":
        return this.handleReject(groupId, userId, parts);
      case "rules":
      case "规则":
        return this.handleRules(groupId, userId, parts);
      case "status":
      case "状态":
        return this.handleStatus(groupId, userId, parts);
      case "test":
      case "测试":
        return this.handleTest(groupId, userId);
      default:
        return { ok: false, text: `未知指令：${parts[0]}\n\n${HELP_TEXT}` };
    }
  }

  private handleMyId(groupId: string | undefined, userId: string): CommandResult {
    return {
      ok: true,
      text: [
        `你的 userId：${userId}`,
        groupId ? `当前群 ID：${groupId}` : "当前会话：私聊",
        "注意：这是官方 OpenID，不是 QQ 号。",
      ].join("\n"),
    };
  }

  private handleMyPermission(
    groupId: string | undefined,
    userId: string,
  ): CommandResult {
    const level = this.permissions.levelFor(userId, groupId);
    return {
      ok: true,
      text: [
        `你的权限等级：${level}`,
        groupId ? `当前群 ID：${groupId}` : "当前会话：私聊",
        `审核入群：${this.permissions.canApproveJoin(userId, groupId ?? "")}`,
        `管理规则：${this.permissions.canManageRules(userId, groupId ?? "")}`,
        `内容审核：${this.permissions.canReviewContent(userId, groupId ?? "")}`,
        `导出数据：${this.permissions.canExportData(userId, groupId ?? "")}`,
        `配置权限：${this.permissions.isSuperAdmin(userId)}`,
      ].join("\n"),
    };
  }

  private handlePermissionConfig(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      log.warn("permission config denied", { groupId, userId });
      return { ok: false, text: "权限不足：仅超级管理员可以配置权限。" };
    }

    const action = normalize(parts[1]);
    if (!action || action === "list" || action === "列表") {
      const targetGroupId = groupId ?? parts[2]?.trim();
      return {
        ok: true,
        text: this.formatPermissionList(targetGroupId),
      };
    }

    const role = normalize(parts[2]);
    const isSuperRole = role === "super" || role === "超管";
    let targetGroupId = groupId;
    let targetUserId: string | undefined;

    if (isSuperRole) {
      targetUserId = parts[3]?.trim();
    } else {
      targetGroupId = groupId ?? parts[3]?.trim();
      targetUserId = groupId ? parts[3]?.trim() : parts[4]?.trim();
    }

    if (!role || !targetUserId) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "/perm grant|revoke super <userId>\n" +
          "/perm grant|revoke admin|mod [group_openid] <userId>",
      };
    }

    if (!isSuperRole && !targetGroupId) {
      return {
        ok: false,
        text: "私信中配置群管理员/审核员需要提供 group_openid。",
      };
    }

    try {
      if (action === "grant" || action === "授予") {
        this.grantRole(targetGroupId, role, targetUserId);
      } else if (action === "revoke" || action === "撤销") {
        this.revokeRole(targetGroupId, role, targetUserId);
      } else {
        return {
          ok: false,
          text:
            "用法：\n" +
            "/perm grant|revoke super <userId>\n" +
            "/perm grant|revoke admin|mod [group_openid] <userId>",
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
      groupId: targetGroupId,
      userId,
      action,
      role,
      targetUserId,
    });
    return {
      ok: true,
      text: `已更新权限：${role} ${targetUserId}\n\n${this.formatPermissionList(targetGroupId)}`,
    };
  }

  private formatPermissionList(groupId?: string): string {
    const lines = [`超级管理员：${formatList(this.permissions.listSuperAdmins())}`];
    if (groupId) {
      lines.push(`群管理员（${groupId}）：${formatList(this.permissions.listGroupAdmins(groupId))}`);
      lines.push(`审核员（${groupId}）：${formatList(this.permissions.listModerators(groupId))}`);
    } else {
      lines.push("群管理员：私信中请指定 group_openid");
      lines.push("审核员：私信中请指定 group_openid");
    }
    return lines.join("\n");
  }

  private grantRole(
    groupId: string | undefined,
    role: string,
    targetUserId: string,
  ): void {
    if (role === "super" || role === "超管") {
      this.permissions.grantSuperAdmin(targetUserId);
      return;
    }
    if (!groupId) {
      throw new Error("group_openid is required");
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

  private revokeRole(
    groupId: string | undefined,
    role: string,
    targetUserId: string,
  ): void {
    if (role === "super" || role === "超管") {
      this.permissions.revokeSuperAdmin(targetUserId);
      return;
    }
    if (!groupId) {
      throw new Error("group_openid is required");
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

  private handlePending(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const targetGroupId = groupId ?? parts[1]?.trim();
    if (!targetGroupId) {
      return {
        ok: false,
        text: "该指令需要在群内使用，或在私信中提供 group_openid。用法：/pending <group_openid>",
      };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    const pending = this.joinAudit.pending(targetGroupId);
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
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const targetGroupId = groupId ?? parts[1]?.trim();
    const requestId = groupId ? parts[1]?.trim() : parts[2]?.trim();
    if (!targetGroupId || !requestId) {
      return {
        ok: false,
        text: "用法：/approve [group_openid] <申请ID>",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        return { ok: false, text: "申请不属于该群。" };
      }
      this.joinAudit.approve(requestId, userId);
    } catch (error) {
      log.warn("approve failed", { requestId, error: String(error) });
      return { ok: false, text: `审批失败：${String(error)}` };
    }
    log.info("approved join request", { requestId, userId });
    return { ok: true, text: `已通过入群申请 ${requestId}。` };
  }

  private handleReject(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const targetGroupId = groupId ?? parts[1]?.trim();
    const requestId = groupId ? parts[1]?.trim() : parts[2]?.trim();
    if (!targetGroupId || !requestId) {
      return {
        ok: false,
        text: "用法：/reject [group_openid] <申请ID> [原因]",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    const reason = groupId
      ? parts.slice(2).join(" ").trim()
      : parts.slice(3).join(" ").trim();
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        return { ok: false, text: "申请不属于该群。" };
      }
      this.joinAudit.reject(requestId, userId, reason);
    } catch (error) {
      log.warn("reject failed", { requestId, error: String(error) });
      return { ok: false, text: `审批失败：${String(error)}` };
    }
    log.info("rejected join request", {
      requestId,
      userId,
      hasReason: reason.length > 0,
    });
    return { ok: true, text: `已拒绝入群申请 ${requestId}。` };
  }

  private handleRules(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const targetGroupId = groupId ?? parts[1]?.trim();
    if (!targetGroupId) {
      return {
        ok: false,
        text: "该指令需要在群内使用，或在私信中提供 group_openid。用法：/rules <group_openid>",
      };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    const config = this.configStore.get(targetGroupId);
    const keywords = config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）";
    return {
      ok: true,
      text: [
        `群 ${targetGroupId} 规则配置：`,
        `启用：${config.enabled}`,
        `关键词过滤：${config.wordFilterEnabled}`,
        `关键词：${keywords}`,
        `入群审核：${config.joinAuditEnabled}`,
        `自动通过：${config.autoApproveJoin}`,
      ].join("\n"),
    };
  }

  private handleStatus(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const targetGroupId = groupId ?? parts[1]?.trim();
    if (!targetGroupId) {
      return {
        ok: false,
        text: "该指令需要在群内使用，或在私信中提供 group_openid。用法：/status <group_openid>",
      };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    const config = this.configStore.get(targetGroupId);
    return {
      ok: true,
      text: [
        `群 ${targetGroupId} 状态：`,
        `机器人启用：${config.enabled}`,
        `消息过滤：${config.wordFilterEnabled}`,
        `入群审核：${config.joinAuditEnabled}`,
        `导出功能：${config.exportEnabled}`,
        `禁言时长：${config.muteDurationSeconds} 秒`,
      ].join("\n"),
    };
  }

  private handleTest(groupId: string | undefined, userId: string): CommandResult {
    if (!this.permissions.canReviewContent(userId, groupId ?? "")) {
      log.warn("test permission denied", { groupId, userId });
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    log.info("test command", { groupId, userId });
    const lines = [
      "测试成功：机器人已响应。",
      groupId ? `群 ID：${groupId}` : "当前会话：私聊",
      `用户 ID：${userId}`,
    ];
    if (groupId) {
      lines.push(`待审批申请：${this.joinAudit.pending(groupId).length}`);
    }
    return { ok: true, text: lines.join("\n") };
  }
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "（空）";
}
