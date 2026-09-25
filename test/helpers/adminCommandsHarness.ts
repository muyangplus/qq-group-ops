import { FakeQQOfficialAPI } from "../../src/adapters/fakeQqOfficial.js";
import { AdminCommandService } from "../../src/services/adminCommands.js";
import { AppealService } from "../../src/services/appeals.js";
import { AuditLogStore } from "../../src/services/audit.js";
import { BlacklistService } from "../../src/services/blacklist.js";
import { ModerationNotifier } from "../../src/services/moderationNotifier.js";
import { PunishmentService } from "../../src/services/punishments.js";
import { ClassAliasService } from "../../src/services/classAliases.js";
import { DisplayNameService } from "../../src/services/displayNames.js";
import { GroupConfigStore } from "../../src/services/groupConfig.js";
import { IdentityMapService } from "../../src/services/identityMap.js";
import { JoinApprovalService } from "../../src/services/joinApproval.js";
import { JoinAuditService } from "../../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../../src/services/joinAuditSync.js";
import { MemberRoster } from "../../src/services/memberRoster.js";
import { NotificationService } from "../../src/services/notifications.js";
import { PermissionService } from "../../src/services/permissions.js";
import { RichMessageSender } from "../../src/services/richMessages.js";
import { ShortCodeService } from "../../src/services/shortCodes.js";
import { UserProfileService } from "../../src/services/userProfiles.js";
import { beforeEach } from "vitest";

/**
 * AdminCommandService 测试共享夹具。
 *
 * 用 `export let` + `beforeEach` 的活绑定模式：测试文件 import 这些名字后
 * 每次用例前都会被重新装配，测试体无需改动即可在多个文件间共享同一套装配逻辑。
 */

export let auditLog: AuditLogStore;
export let joinAudit: JoinAuditService;
export let configStore: GroupConfigStore;
export let identityMap: IdentityMapService;
export let permissions: PermissionService;
export let api: FakeQQOfficialAPI;
export let joinApproval: JoinApprovalService;
export let joinSync: JoinRequestSyncService;
export let notifications: NotificationService;
export let service: AdminCommandService;
export let shortCodes: ShortCodeService;
/** §A5 黑名单（本群 / 全局）。 */
export let blacklist: BlacklistService;
/** §B7 处罚记录与卡片动作。 */
export let punishments: PunishmentService;
/** §B8 申诉记录。 */
export let appeals: AppealService;
/** 处罚 / 申诉私信推送（用订阅表 `punish` 频道）。 */
export let moderationNotifier: ModerationNotifier;

  /** 最近一条发给某人的私信正文（`/whois` 结果只走私信）。 */
export function privateText(userId: string): string {
    const message = api.sentPrivateMessages
      .filter((item) => item.userOpenid === userId)
      .at(-1);
    return String(message?.markdown ?? message?.content ?? "");
  }

  /** 带富消息发送器的服务（`/testat` 需要纯文本通道）。 */
export function withSender(): AdminCommandService {
    shortCodes = new ShortCodeService();
    return new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      notifications,
      display: new DisplayNameService(identityMap, shortCodes),
      richMessages: new RichMessageSender(api),
    });
  }

  /** 带短码展示的服务：生产装配路径（DisplayNameService）的最小替身。 */
export function withShortCodes(): AdminCommandService {
    shortCodes = new ShortCodeService();
    return new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      notifications,
      display: new DisplayNameService(identityMap, shortCodes),
    });
  }

  /** 同时装配短码展示、个人资料与班级别名的替身。 */
export function withProfiles(): {
    svc: AdminCommandService;
    profiles: UserProfileService;
    aliases: ClassAliasService;
  } {
    shortCodes = new ShortCodeService();
    const roster = MemberRoster.fromIndex({
      classes: ["材化2211", "环工2414"],
      majors: ["材料化学", "环境工程"],
      classInfo: {
        材化2211: {
          major: "材料化学",
          college: "化学与生命科学学院",
          year: "2022",
        },
        环工2414: {
          major: "环境工程",
          college: "环境科学与工程学院",
          year: "2024",
        },
      },
    });
    const profiles = new UserProfileService();
    profiles.setRoster(roster);
    const aliases = new ClassAliasService();
    aliases.setRoster(roster);
    const svc = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      notifications,
      userProfiles: profiles,
      classAliases: aliases,
      display: new DisplayNameService(identityMap, shortCodes),
    });
    return { svc, profiles, aliases };
  }

export function scopedShortCodeLabel(
    kind: "user" | "group" | "join_request",
    targetId: string,
  ): string {
    return shortCodes.label(kind, targetId);
  }

  beforeEach(() => {
    auditLog = new AuditLogStore();
    permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      moderatorIds: new Map([["g1", new Set(["mod"])]]),
    });
    joinAudit = new JoinAuditService(auditLog);
    configStore = new GroupConfigStore({
      groupId: "__default__",
      keywords: ["广告"],
    });
    api = new FakeQQOfficialAPI();
    joinSync = new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 });
    identityMap = new IdentityMapService();
    identityMap.bindUser("member", "10001");
    identityMap.bindUser("mod", "10002");
    identityMap.bindUser("admin", "10003");
    identityMap.bindUser("root", "10004");
    identityMap.bindUser("u3", "10005");
    identityMap.bindUser("u4", "10006");
    identityMap.bindGroup("g1", "654321");
    notifications = new NotificationService(api, permissions, {
      identityMap,
      configStore,
    });
    // §A5：本群黑名单在 g1 生效；全局黑名单踢出所有绑定群（测试里就是 g1）。
    blacklist = new BlacklistService(api, {
      auditLog,
      listBoundGroups: () => ["g1"],
    });
    moderationNotifier = new ModerationNotifier({
      notifications,
      permissions,
      groupLabel: (groupId) => identityMap.getGroupNumber(groupId) ?? groupId,
      userLabel: (userId) => identityMap.getQq(userId) ?? userId,
    });
    punishments = new PunishmentService(api, blacklist, {
      auditLog,
      notifier: moderationNotifier,
    });
    appeals = new AppealService();
    joinApproval = new JoinApprovalService(
      api,
      joinAudit,
      configStore,
      undefined,
      blacklist,
    );
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      notifications,
      blacklist,
      punishments,
      appeals,
      moderationNotifier,
    });
  });
