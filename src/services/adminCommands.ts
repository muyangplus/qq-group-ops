import { getLogger } from "../core/logger.js";
import type { GroupConfigStore } from "./groupConfig.js";
import type { GroupMessageModeRegistry } from "./groupMessageMode.js";
import type { IdentityMapService } from "./identityMap.js";
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
/bind qq <QQ号> - 绑定自己的 QQ 号
/bind group <群号> - 绑定当前群号（群管理员）
/bind user <userId> <QQ号> - 绑定任意用户（超管）
/bind groupid <group_openid> <群号> - 绑定任意群（超管）
/whois <QQ号|userId|群号|group_openid> - 查询映射（超管）

说明：私信中执行群管理指令时，需要提供 group_openid 或已绑定的群号。`;

export interface CommandResult {
  ok: boolean;
  text: string;
}

export class AdminCommandService {
  public constructor(
    private readonly permissions: PermissionService,
    private readonly joinAudit: JoinAuditService,
    private readonly configStore: GroupConfigStore,
    private readonly groupMessageMode?: GroupMessageModeRegistry,
    private readonly identityMap?: IdentityMapService,
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

    const bindingExempt = new Set(["help", "帮助", "bind", "绑定", "myid", "我的id"]);
    if (
      !bindingExempt.has(command) &&
      this.identityMap &&
      !this.identityMap.getQq(userId)
    ) {
      log.warn("binding required", { groupId, userId, command });
      return {
        ok: false,
        text: "请先绑定 QQ 号：/bind qq <QQ号>",
      };
    }

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
      case "bind":
      case "绑定":
        return this.handleBind(groupId, userId, parts);
      case "whois":
      case "查询":
        return this.handleWhois(userId, parts);
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
    const qq = this.identityMap?.getQq(userId);
    const groupNumber = groupId
      ? this.identityMap?.getGroupNumber(groupId)
      : undefined;
    return {
      ok: true,
      text: [
        `你的 userId：${userId}`,
        qq ? `你的 QQ 号：${qq}` : "你的 QQ 号：未绑定",
        groupId ? `当前群 ID：${groupId}` : "当前会话：私聊",
        groupNumber ? `当前群号：${groupNumber}` : undefined,
        "注意：这是官方 OpenID，不是 QQ 号。",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    };
  }

  private handleBind(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const target = normalize(parts[1]);
    if (!target) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "/bind qq <QQ号>\n" +
          "/bind group <群号>\n" +
          "/bind user <userId> <QQ号>（超管）\n" +
          "/bind groupid <group_openid> <群号>（超管）",
      };
    }

    if (target === "qq") {
      const qq = parts[2]?.trim();
      if (!qq) {
        return { ok: false, text: "用法：/bind qq <QQ号>" };
      }
      this.identityMap?.bindUser(userId, qq);
      log.info("bound user qq", { userId, qq });
      return { ok: true, text: `已绑定：userId ${userId} ↔ QQ ${qq}` };
    }

    if (target === "group") {
      const groupNumber = parts[2]?.trim();
      if (!groupId || !groupNumber) {
        return {
          ok: false,
          text: "该指令需要在群内使用。用法：/bind group <群号>",
        };
      }
      if (
        !this.permissions.canApproveJoin(userId, groupId) &&
        !this.permissions.isSuperAdmin(userId)
      ) {
        return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
      }
      this.identityMap?.bindGroup(groupId, groupNumber);
      log.info("bound group number", { groupId, groupNumber, userId });
      return { ok: true, text: `已绑定：group_openid ${groupId} ↔ 群号 ${groupNumber}` };
    }

    if (target === "user") {
      if (!this.permissions.isSuperAdmin(userId)) {
        return { ok: false, text: "权限不足：仅超级管理员可以绑定任意用户。" };
      }
      const officialId = parts[2]?.trim();
      const qq = parts[3]?.trim();
      if (!officialId || !qq) {
        return { ok: false, text: "用法：/bind user <userId> <QQ号>" };
      }
      this.identityMap?.bindUser(officialId, qq);
      log.info("bound user qq", { officialId, qq, operator: userId });
      return { ok: true, text: `已绑定：userId ${officialId} ↔ QQ ${qq}` };
    }

    if (target === "groupid") {
      if (!this.permissions.isSuperAdmin(userId)) {
        return { ok: false, text: "权限不足：仅超级管理员可以绑定任意群。" };
      }
      const officialId = parts[2]?.trim();
      const groupNumber = parts[3]?.trim();
      if (!officialId || !groupNumber) {
        return { ok: false, text: "用法：/bind groupid <group_openid> <群号>" };
      }
      this.identityMap?.bindGroup(officialId, groupNumber);
      log.info("bound group number", {
        officialId,
        groupNumber,
        operator: userId,
      });
      return {
        ok: true,
        text: `已绑定：group_openid ${officialId} ↔ 群号 ${groupNumber}`,
      };
    }

    return {
      ok: false,
      text:
        "未知绑定类型。用法：\n" +
        "/bind qq <QQ号>\n" +
        "/bind group <群号>\n" +
        "/bind user <userId> <QQ号>（超管）\n" +
        "/bind groupid <group_openid> <群号>（超管）",
    };
  }

  private handleWhois(userId: string, parts: readonly string[]): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：仅超级管理员可以查询映射。" };
    }
    if (!this.identityMap) {
      return { ok: false, text: "映射服务未启用。" };
    }
    const input = parts[1]?.trim();
    if (!input) {
      return {
        ok: false,
        text: "用法：/whois <QQ号|userId|群号|group_openid>",
      };
    }
    const resolvedUserId = this.identityMap.resolveUserId(input);
    if (resolvedUserId) {
      const qq = this.identityMap.getQq(resolvedUserId) ?? "（未绑定）";
      return {
        ok: true,
        text: `类型：用户\nuserId：${resolvedUserId}\nQQ：${qq}`,
      };
    }
    const resolvedGroupId = this.identityMap.resolveGroupId(input);
    if (resolvedGroupId) {
      const groupNumber =
        this.identityMap.getGroupNumber(resolvedGroupId) ?? "（未绑定）";
      return {
        ok: true,
        text: `类型：群\n群 ID：${resolvedGroupId}\n群号：${groupNumber}`,
      };
    }
    return { ok: false, text: "未找到映射。" };
  }

  private resolveUserId(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    return this.identityMap?.resolveUserId(trimmed) ?? trimmed;
  }

  private resolveTargetGroupId(
    groupId: string | undefined,
    input: string | undefined,
  ): string | undefined {
    if (groupId) {
      return groupId;
    }
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (!this.identityMap) {
      return trimmed;
    }
    return this.identityMap.resolveGroupId(trimmed);
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
      const targetGroupId = this.resolveTargetGroupId(groupId, parts[2]);
      return {
        ok: true,
        text: this.formatPermissionList(targetGroupId),
      };
    }

    const role = normalize(parts[2]);
    const isSuperRole = role === "super" || role === "超管";
    let targetGroupId: string | undefined;
    let targetUserId: string | undefined;

    if (isSuperRole) {
      targetUserId = this.resolveUserId(parts[3]);
    } else {
      targetGroupId = this.resolveTargetGroupId(groupId, parts[3]);
      targetUserId = this.resolveUserId(groupId ? parts[3] : parts[4]);
    }

    if (!role || !targetUserId) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "/perm grant|revoke super <userId|QQ号>\n" +
          "/perm grant|revoke admin|mod [group_openid|群号] <userId|QQ号>",
      };
    }

    if (!isSuperRole && !targetGroupId) {
      return {
        ok: false,
        text: "私信中配置群管理员/审核员需要提供 group_openid 或已绑定的群号。",
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
            "/perm grant|revoke super <userId|QQ号>\n" +
            "/perm grant|revoke admin|mod [group_openid|群号] <userId|QQ号>",
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
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
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
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
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
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
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
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
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
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
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
    const groupNumber = this.identityMap?.getGroupNumber(targetGroupId);
    return {
      ok: true,
      text: [
        `群 ${targetGroupId} 状态：`,
        groupNumber ? `群号：${groupNumber}` : undefined,
        `机器人启用：${config.enabled}`,
        `消息过滤：${config.wordFilterEnabled}`,
        `全量消息模式：${this.groupMessageMode?.get(targetGroupId) ?? "unknown"}`,
        `入群审核：${config.joinAuditEnabled}`,
        `导出功能：${config.exportEnabled}`,
        `禁言时长：${config.muteDurationSeconds} 秒`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
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
