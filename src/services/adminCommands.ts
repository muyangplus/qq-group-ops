import { PermissionLevel } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AuditLog } from "./audit.js";
import {
  DEFAULT_GROUP_ID,
  type EffectiveGroupConfig,
  type GroupConfigOverride,
  type GroupConfigStore,
} from "./groupConfig.js";
import type { GroupMessageModeRegistry } from "./groupMessageMode.js";
import type { IdentityMapService } from "./identityMap.js";
import type { JoinApprovalService } from "./joinApproval.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { JoinRequestSyncService } from "./joinAuditSync.js";
import type { PermissionService } from "./permissions.js";

const log = getLogger("admin-commands");

export interface CommandResult {
  ok: boolean;
  text: string;
}

export interface AdminCommandServiceOptions {
  permissions: PermissionService;
  joinAudit: JoinAuditService;
  configStore: GroupConfigStore;
  joinApproval: JoinApprovalService;
  joinSync: JoinRequestSyncService;
  auditLog: AuditLog;
  groupMessageMode?: GroupMessageModeRegistry | undefined;
  identityMap?: IdentityMapService | undefined;
}

export class AdminCommandService {
  private readonly permissions: PermissionService;
  private readonly joinAudit: JoinAuditService;
  private readonly configStore: GroupConfigStore;
  private readonly joinApproval: JoinApprovalService;
  private readonly joinSync: JoinRequestSyncService;
  private readonly auditLog: AuditLog;
  private readonly groupMessageMode: GroupMessageModeRegistry | undefined;
  private readonly identityMap: IdentityMapService | undefined;

  public constructor(options: AdminCommandServiceOptions) {
    this.permissions = options.permissions;
    this.joinAudit = options.joinAudit;
    this.configStore = options.configStore;
    this.joinApproval = options.joinApproval;
    this.joinSync = options.joinSync;
    this.auditLog = options.auditLog;
    this.groupMessageMode = options.groupMessageMode;
    this.identityMap = options.identityMap;
  }

  public async handle(
    groupId: string | undefined,
    userId: string,
    text: string,
  ): Promise<CommandResult> {
    const parts = text.trim().split(/\s+/u).filter((part) => part.length > 0);
    if (parts.length === 0) {
      return { ok: false, text: this.buildHelp(groupId, userId) };
    }
    const command = parts[0]!.replace(/^\//u, "").toLowerCase();
    log.debug("command", { groupId, userId, command });

    const bindingExempt = new Set(["help", "帮助", "bind", "绑定"]);
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

    if (
      groupId &&
      !bindingExempt.has(command) &&
      this.identityMap &&
      !this.identityMap.getGroupNumber(groupId)
    ) {
      log.warn("group binding required", { groupId, userId, command });
      return {
        ok: false,
        text: "请先绑定本群：/bind group <群号>",
      };
    }

    switch (command) {
      case "help":
      case "帮助":
        return { ok: true, text: this.buildHelp(groupId, userId) };
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
      case "sync":
      case "同步":
        return this.handleSync(groupId, userId, parts);
      case "approve":
      case "通过":
        return this.handleApprove(groupId, userId, parts);
      case "reject":
      case "拒绝":
        return this.handleReject(groupId, userId, parts);
      case "rules":
      case "规则":
        return this.handleRules(groupId, userId, parts);
      case "audit":
      case "日志":
        return this.handleAudit(groupId, userId, parts);
      case "status":
      case "状态":
        return this.handleStatus(groupId, userId, parts);
      case "test":
      case "测试":
        return this.handleTest(groupId, userId);
      default:
        return { ok: false, text: `未知指令：${parts[0]}\n\n${this.buildHelp(groupId, userId)}` };
    }
  }

  private async handleBind(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
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
      try {
        await this.identityMap?.bindUser(userId, qq);
      } catch (error) {
        log.error("bind user qq failed", {
          userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound user qq", { userId, qq });
      return {
        ok: true,
        text: `已绑定：userId ${userId} ↔ QQ ${qq}`,
      };
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
      try {
        await this.identityMap?.bindGroup(groupId, groupNumber);
      } catch (error) {
        log.error("bind group number failed", {
          groupId,
          userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound group number", { groupId, groupNumber, userId });
      return {
        ok: true,
        text: `已绑定：group_openid ${groupId} ↔ 群号 ${groupNumber}`,
      };
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
      try {
        await this.identityMap?.bindUser(officialId, qq);
      } catch (error) {
        log.error("bind user failed", {
          officialId,
          operator: userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound user qq", { officialId, qq, operator: userId });
      return {
        ok: true,
        text: `已绑定：userId ${officialId} ↔ QQ ${qq}`,
      };
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
      try {
        await this.identityMap?.bindGroup(officialId, groupNumber);
      } catch (error) {
        log.error("bind group failed", {
          officialId,
          operator: userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
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

  private buildHelp(groupId: string | undefined, userId: string): string {
    const lines: string[] = [
      "可用指令：",
      "/help - 显示帮助",
      "/bind qq <QQ号> - 绑定自己的 QQ 号",
    ];
    const isSuper = this.permissions.isSuperAdmin(userId);
    const canBindGroup =
      groupId !== undefined &&
      (isSuper || this.permissions.canApproveJoin(userId, groupId));
    if (canBindGroup) {
      lines.push("/bind group <群号> - 绑定当前群号");
    }
    if (isSuper) {
      lines.push("/bind user <userId> <QQ号> - 绑定任意用户");
      lines.push("/bind groupid <group_openid> <群号> - 绑定任意群");
      lines.push("/whois <QQ号|userId|群号|group_openid> - 查询映射");
    }

    const isBound = this.identityMap
      ? Boolean(this.identityMap.getQq(userId))
      : true;
    if (!isBound) {
      lines.push("", "请先绑定 QQ 号：/bind qq <QQ号>");
      lines.push("绑定后使用 /help 查看可用指令。");
      return lines.join("\n");
    }

    const groupBound = groupId !== undefined
      ? Boolean(this.identityMap?.getGroupNumber(groupId))
      : true;
    if (groupId !== undefined && !groupBound) {
      lines.push("", "本群未绑定，群管理指令不可用。");
      lines.push(
        canBindGroup
          ? "请先绑定本群：/bind group <群号>"
          : "请联系群管理员绑定本群：/bind group <群号>",
      );
      return lines.join("\n");
    }

    lines.push("/myperm - 查看自己的权限");
    const canModerate =
      groupId !== undefined
        ? this.permissions.canReviewContent(userId, groupId)
        : this.permissions.hasAnyGroupRole(userId, PermissionLevel.Moderator);
    const canAdmin =
      groupId !== undefined
        ? this.permissions.canApproveJoin(userId, groupId)
        : this.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin);

    if (canModerate) {
      lines.push("/pending [group_openid|群号] - 查看待审批入群申请");
      lines.push("/sync [group_openid|群号] - 从官方接口同步待审批申请");
      lines.push("/rules [group_openid|群号] - 查看群规则配置");
      lines.push("/audit [group_openid|群号] [数量] - 查看最近审计记录");
      lines.push("/status [group_openid|群号] - 查看群运行状态");
      lines.push("/test - 测试机器人是否正常响应");
    }
    if (canAdmin) {
      lines.push("/approve [group_openid|群号] <申请ID> - 通过入群申请");
      lines.push("/reject [group_openid|群号] <申请ID> [原因] - 拒绝入群申请");
      lines.push("/rules set <字段> <值> - 修改群规则（关键词、警告文案等）");
    }
    if (isSuper) {
      lines.push("/perm list [group_openid|群号] - 查看权限配置");
      lines.push("/perm grant super <userId|QQ号> - 授予全局超管");
      lines.push("/perm revoke super <userId|QQ号> - 撤销全局超管");
      lines.push("/perm grant gsuper [group_openid|群号] <userId|QQ号> - 授予本群超管");
      lines.push("/perm revoke gsuper [group_openid|群号] <userId|QQ号> - 撤销本群超管");
      lines.push("/perm grant admin [group_openid|群号] <userId|QQ号> - 授予群管理员");
      lines.push("/perm revoke admin [group_openid|群号] <userId|QQ号> - 撤销群管理员");
      lines.push("/perm grant mod [group_openid|群号] <userId|QQ号> - 授予审核员");
      lines.push("/perm revoke mod [group_openid|群号] <userId|QQ号> - 撤销审核员");
      lines.push("/rules all - 查看全局默认规则");
      lines.push("/rules set all <字段> <值> - 修改全局默认规则");
    }
    if (!canModerate && !canAdmin && !isSuper) {
      lines.push("当前没有更多可执行的管理指令。");
    }
    return lines.join("\n");
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
        `全局超级管理员：${this.permissions.isSuperAdmin(userId)}`,
        groupId
          ? `本群超级管理员：${this.permissions.isGroupSuperAdmin(userId, groupId)}`
          : undefined,
        groupId ? `当前群 ID：${groupId}` : "当前会话：私聊",
        `审核入群：${this.permissions.canApproveJoin(userId, groupId ?? "")}`,
        `管理规则：${this.permissions.canManageRules(userId, groupId ?? "")}`,
        `内容审核：${this.permissions.canReviewContent(userId, groupId ?? "")}`,
        `导出数据：${this.permissions.canExportData(userId, groupId ?? "")}`,
        `配置权限：${this.permissions.isSuperAdmin(userId)}`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
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
    const isGroupSuperRole = GROUP_SUPER_ROLES.has(role);
    let targetGroupId: string | undefined;
    let targetUserId: string | undefined;

    if (isSuperRole) {
      targetUserId = this.resolveUserId(parts[3]);
    } else if (isGroupSuperRole) {
      targetGroupId = groupId ?? this.resolveTargetGroupId(undefined, parts[3]);
      targetUserId = this.resolveUserId(groupId ? parts[3] : parts[4]);
    } else {
      targetGroupId = this.resolveTargetGroupId(groupId, parts[3]);
      targetUserId = this.resolveUserId(groupId ? parts[3] : parts[4]);
    }

    if (!role) {
      return { ok: false, text: PERM_USAGE };
    }

    if (!isSuperRole && !targetGroupId) {
      return {
        ok: false,
        text: "私信中配置群角色需要提供 group_openid 或已绑定的群号。",
      };
    }

    if (!targetUserId) {
      return { ok: false, text: PERM_USAGE };
    }

    try {
      if (action === "grant" || action === "授予") {
        this.grantRole(targetGroupId, role, targetUserId);
      } else if (action === "revoke" || action === "撤销") {
        this.revokeRole(targetGroupId, role, targetUserId);
      } else {
        return { ok: false, text: PERM_USAGE };
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
    const lines = [`全局超级管理员：${formatList(this.permissions.listSuperAdmins())}`];
    if (groupId) {
      lines.push(
        `本群超级管理员（${groupId}）：${formatList(this.permissions.listGroupSuperAdmins(groupId))}`,
      );
      lines.push(`群管理员（${groupId}）：${formatList(this.permissions.listGroupAdmins(groupId))}`);
      lines.push(`审核员（${groupId}）：${formatList(this.permissions.listModerators(groupId))}`);
    } else {
      lines.push("本群超级管理员：私信中请指定 group_openid");
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
    if (GROUP_SUPER_ROLES.has(role)) {
      this.permissions.grantGroupSuperAdmin(groupId, targetUserId);
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
    if (GROUP_SUPER_ROLES.has(role)) {
      this.permissions.revokeGroupSuperAdmin(groupId, targetUserId);
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

  private async handleSync(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      return {
        ok: false,
        text: "该指令需要在群内使用，或在私信中提供 group_openid。用法：/sync [group_openid|群号]",
      };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    let pending;
    try {
      pending = await this.joinSync.syncGroup(targetGroupId);
    } catch (error) {
      log.warn("join sync failed", {
        groupId: targetGroupId,
        error: formatError(error),
      });
      return { ok: false, text: `同步失败：${formatError(error)}` };
    }
    if (pending.length === 0) {
      return { ok: true, text: "已同步官方待审批申请：当前没有待审批申请。" };
    }
    const lines = [`已同步官方待审批申请，当前待审批 ${pending.length} 条：`];
    for (const request of pending.slice(0, 5)) {
      const reason = request.reason ? ` 理由：${request.reason}` : "";
      lines.push(`- ${request.requestId} 用户：${request.userId}${reason}`);
    }
    if (pending.length > 5) {
      lines.push(`（仅显示前 5 条，使用 /pending 查看全部）`);
    }
    return { ok: true, text: lines.join("\n") };
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

  private async handleApprove(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
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
      await this.joinApproval.approve(targetGroupId, requestId, userId);
    } catch (error) {
      log.warn("approve failed", { requestId, error: formatError(error) });
      return { ok: false, text: `审批失败：${formatError(error)}` };
    }
    log.info("approved join request", { requestId, userId });
    return { ok: true, text: `已通过入群申请 ${requestId}。` };
  }

  private async handleReject(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
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
      await this.joinApproval.reject(targetGroupId, requestId, userId, reason);
    } catch (error) {
      log.warn("reject failed", { requestId, error: formatError(error) });
      return { ok: false, text: `审批失败：${formatError(error)}` };
    }
    log.info("rejected join request", {
      requestId,
      userId,
      hasReason: reason.length > 0,
    });
    return { ok: true, text: `已拒绝入群申请 ${requestId}。` };
  }

  private async handleRules(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const action = normalize(parts[1]);
    if (action === "set" || action === "设置") {
      return this.handleRulesSet(groupId, userId, parts);
    }
    if (isGlobalTarget(parts[1])) {
      return this.handleGlobalRulesView(userId);
    }

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
    return { ok: true, text: this.formatRules(targetGroupId) };
  }

  /** 全局规则：仅超级管理员可查看。 */
  private handleGlobalRulesView(userId: string): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: GLOBAL_RULES_DENIED };
    }
    return { ok: true, text: this.formatGlobalRules() };
  }

  private async handleRulesSet(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const args = parts.slice(2);
    if (isGlobalTarget(args[0])) {
      return this.handleGlobalRulesSet(userId, args.slice(1));
    }

    const targetGroupId = groupId ?? this.resolveTargetGroupId(undefined, args[0]);
    const field = groupId ? args[0] : args[1];
    const valueParts = groupId ? args.slice(1) : args.slice(2);

    if (!targetGroupId) {
      return {
        ok: false,
        text: "私信中设置规则需要提供已绑定的 group_openid 或群号。用法：/rules set <group_openid> <字段> <值>",
      };
    }
    if (!this.permissions.canManageRules(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    if (!field || valueParts.length === 0) {
      return { ok: false, text: RULES_SET_USAGE };
    }

    const value = valueParts.join(" ").trim();
    let override: GroupConfigOverride;
    try {
      override = parseRuleSetting(targetGroupId, field, value, this.configStore);
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }

    this.configStore.setOverride(override);
    log.info("group rules updated", {
      groupId: targetGroupId,
      userId,
      field: normalize(field),
    });
    return {
      ok: true,
      text: `已更新群规则。\n\n${this.formatRules(targetGroupId)}`,
    };
  }

  /** 全局规则：仅超级管理员可修改。 */
  private async handleGlobalRulesSet(
    userId: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: GLOBAL_RULES_DENIED };
    }
    const field = args[0];
    const valueParts = args.slice(1);
    if (!field || valueParts.length === 0) {
      return { ok: false, text: GLOBAL_RULES_SET_USAGE };
    }

    const value = valueParts.join(" ").trim();
    let override: GroupConfigOverride;
    try {
      override = parseRuleSetting(DEFAULT_GROUP_ID, field, value, this.configStore);
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }

    this.configStore.setOverride(override);
    log.info("global rules updated", { userId, field: normalize(field) });
    return {
      ok: true,
      text: `已更新全局规则（影响所有未单独覆盖的群）。\n\n${this.formatGlobalRules()}`,
    };
  }

  private formatRules(targetGroupId: string): string {
    return formatEffectiveConfig(
      this.configStore.get(targetGroupId),
      `群 ${targetGroupId} 规则配置：`,
    );
  }

  private formatGlobalRules(): string {
    return formatEffectiveConfig(
      this.configStore.default,
      "全局默认规则（未单独配置的群继承）：",
    );
  }

  private handleAudit(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      return {
        ok: false,
        text: "该指令需要在群内使用，或在私信中提供 group_openid。用法：/audit [数量]",
      };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要审核员或以上权限。" };
    }
    const limitArgument = groupId ? parts[1] : parts[2];
    const limit = clampLimit(limitArgument);
    const records = this.auditLog
      .findByGroup(targetGroupId)
      .slice(-limit)
      .reverse();
    if (records.length === 0) {
      return { ok: true, text: "暂无审计记录。" };
    }
    const lines = [`最近 ${records.length} 条审计记录：`];
    for (const record of records) {
      const target = record.targetUserId ? ` → ${record.targetUserId}` : "";
      lines.push(
        `${formatTime(record.createdAt)} ${record.action} ${record.status}${
          record.actorId ? ` by ${record.actorId}` : ""
        }${target}`,
      );
    }
    return { ok: true, text: lines.join("\n") };
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bindingFailureText(): string {
  return "绑定失败：数据库写入异常，请查看服务端日志后重试。";
}

const RULE_FIELDS_HELP = [
  "  keywords 广告,刷屏 / keywords clear",
  "  warning <文案> / warning clear",
  "  muteDuration <秒>",
  "  wordFilter on|off",
  "  joinAudit on|off",
  "  autoApprove on|off",
  "  export on|off",
  "  enabled on|off",
];

const RULES_SET_USAGE = [
  "用法：/rules set <字段> <值>",
  "字段：",
  ...RULE_FIELDS_HELP,
  "私信中使用：/rules set <group_openid> <字段> <值>",
].join("\n");

const GLOBAL_RULES_SET_USAGE = [
  "用法：/rules set all <字段> <值>（仅超级管理员）",
  "字段：",
  ...RULE_FIELDS_HELP,
].join("\n");

const GLOBAL_RULES_DENIED =
  "权限不足：全局规则仅超级管理员可以查看与修改。";

const MAX_MUTE_DURATION_SECONDS = 30 * 24 * 60 * 60;
const MAX_AUDIT_LIMIT = 50;
const DEFAULT_AUDIT_LIMIT = 10;
const GLOBAL_TARGETS = new Set(["all", "global", "default", "全局", "默认"]);
/** `/perm grant gsuper` 的别名：本群超级管理员。 */
const GROUP_SUPER_ROLES = new Set([
  "gsuper",
  "groupsuper",
  "群超管",
  "本群超管",
  "群超级管理员",
]);
const PERM_USAGE = [
  "用法：",
  "/perm list [group_openid|群号]",
  "/perm grant|revoke super <userId|QQ号> - 全局超级管理员",
  "/perm grant|revoke gsuper [group_openid|群号] <userId|QQ号> - 本群超级管理员",
  "/perm grant|revoke admin [group_openid|群号] <userId|QQ号> - 群管理员",
  "/perm grant|revoke mod [group_openid|群号] <userId|QQ号> - 审核员",
].join("\n");
const TOGGLE_ON = new Set(["on", "true", "1", "yes", "y", "开", "启用", "是"]);
const TOGGLE_OFF = new Set(["off", "false", "0", "no", "n", "关", "关闭", "否"]);
const CLEAR_WORDS = new Set(["clear", "清空", "默认", "reset"]);

/** `/rules all`、`/rules 全局`、`/rules set default ...` 都指向全局规则。 */
function isGlobalTarget(value: string | undefined): boolean {
  return GLOBAL_TARGETS.has(normalize(value));
}

function formatEffectiveConfig(
  config: EffectiveGroupConfig,
  header: string,
): string {
  const keywords =
    config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）";
  return [
    header,
    `启用：${config.enabled}`,
    `关键词过滤：${config.wordFilterEnabled}`,
    `关键词：${keywords}`,
    `入群审核：${config.joinAuditEnabled}`,
    `自动通过：${config.autoApproveJoin}`,
    `导出功能：${config.exportEnabled}`,
    `警告文案：${config.warningMessage}`,
    `禁言时长：${config.muteDurationSeconds} 秒`,
  ].join("\n");
}

function parseRuleSetting(
  groupId: string,
  field: string,
  value: string,
  configStore: GroupConfigStore,
): GroupConfigOverride {
  const cleared = CLEAR_WORDS.has(value.toLowerCase());
  switch (normalize(field)) {
    case "keywords":
    case "keyword":
    case "关键词":
      return {
        groupId,
        keywords: cleared
          ? []
          : value
              .split(/[,，、\s]+/u)
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
      };
    case "warning":
    case "warningmessage":
    case "警告":
      return {
        groupId,
        warningMessage: cleared
          ? groupId === DEFAULT_GROUP_ID
            ? configStore.builtinDefault.warningMessage
            : configStore.default.warningMessage
          : value,
      };
    case "muteduration":
    case "mute":
    case "禁言时长":
      return { groupId, muteDurationSeconds: parseDuration(value) };
    case "autoapprove":
    case "自动通过":
      return { groupId, autoApproveJoin: parseToggle(field, value) };
    case "joinaudit":
    case "入群审核":
      return { groupId, joinAuditEnabled: parseToggle(field, value) };
    case "wordfilter":
    case "关键词过滤":
      return { groupId, wordFilterEnabled: parseToggle(field, value) };
    case "export":
    case "导出":
      return { groupId, exportEnabled: parseToggle(field, value) };
    case "enabled":
    case "启用":
      return { groupId, enabled: parseToggle(field, value) };
    default:
      throw new Error(`未知字段：${field}`);
  }
}

function parseToggle(field: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (TOGGLE_ON.has(normalized)) {
    return true;
  }
  if (TOGGLE_OFF.has(normalized)) {
    return false;
  }
  throw new Error(`${field} 需要 on 或 off`);
}

function parseDuration(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("禁言时长需要非负整数（秒）");
  }
  return Math.min(parsed, MAX_MUTE_DURATION_SECONDS);
}

function clampLimit(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUDIT_LIMIT;
  }
  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

function formatTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}
