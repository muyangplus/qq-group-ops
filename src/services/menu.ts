import { PermissionLevel } from "../core/enums.js";
import { renderCard, escapeCardText, type CardButton, type CardSpec } from "./cardTemplate.js";
import type { PermissionService } from "./permissions.js";
import type { RichMessage } from "./richMessages.js";

/**
 * QQ 端系统交互菜单。
 *
 * 三级结构（按你的确认）：
 *   主菜单 `/menu` → 系统菜单 / 管理菜单 / 超管菜单 → 各功能子菜单
 *
 * 按钮全部是**指令按钮**（`action.type = 2`）：点击等价于发送对应指令，因此不需要
 * 新增任何事件类型，权限校验、审计与降级逻辑与手输指令完全一致。需要参数的指令
 * （如 `/approve <申请ID>`）在正文里给出用法，不带按钮，避免出现点不动的死按钮。
 *
 * 权限过滤与 `/help` 一致：看不到的入口不会出现在卡片上；直接调用 `/menu admin`
 * 这类越权入口会被拒绝。
 */
export type MenuSection =
  | "main"
  | "sys"
  | "activity"
  | "admin"
  | "review"
  | "ops"
  | "super";

export const MENU_SECTIONS: readonly MenuSection[] = [
  "main",
  "sys",
  "activity",
  "admin",
  "review",
  "ops",
  "super",
];

const SECTION_ALIASES: Record<string, MenuSection> = {
  main: "main",
  menu: "main",
  主菜单: "main",
  首页: "main",
  sys: "sys",
  system: "sys",
  系统: "sys",
  系统菜单: "sys",
  admin: "admin",
  manage: "admin",
  管理: "admin",
  管理菜单: "admin",
  super: "super",
  超管: "super",
  超管菜单: "super",
  超级管理员: "super",
  activity: "activity",
  活动: "activity",
  活动报名: "activity",
  review: "review",
  审核: "review",
  审核操作: "review",
  ops: "ops",
  operation: "ops",
  运营: "ops",
  活动运营: "ops",
};

export function findMenuSection(input: string | undefined): MenuSection | undefined {
  if (!input) {
    return undefined;
  }
  return SECTION_ALIASES[input.trim().toLowerCase()];
}

export interface MenuContext {
  userId: string;
  /** 群上下文；私信时为 undefined。 */
  groupId?: string | undefined;
  /** 调用方解析好的展示名（群号 / 短码）。 */
  groupLabel?: string | undefined;
  /** 调用方解析好的展示名（QQ号 / 短码）。 */
  userLabel?: string | undefined;
  /** 用户是否已绑定自己的 QQ 号。 */
  bound: boolean;
  /** 本群是否已绑定群号；私信时为 undefined。 */
  groupBound?: boolean | undefined;
  permissions: PermissionService;
}

export interface MenuAccess {
  isSuperAdmin: boolean;
  isGroupSuperAdmin: boolean;
  /** 审核员及以上（本群；私信时=在任一群拥有该角色）。 */
  canModerate: boolean;
  /** 群管理员及以上（本群；私信时=在任一群拥有该角色）。 */
  canAdmin: boolean;
}

export interface MenuView {
  section: MenuSection;
  ok: boolean;
  message: RichMessage;
}

const LEVEL_LABELS: Record<PermissionLevel, string> = {
  [PermissionLevel.Guest]: "未绑定",
  [PermissionLevel.Member]: "群成员",
  [PermissionLevel.Moderator]: "审核员",
  [PermissionLevel.GroupAdmin]: "群管理员",
  [PermissionLevel.SuperAdmin]: "超级管理员",
};

export function resolveMenuAccess(context: MenuContext): MenuAccess {
  const { permissions, userId, groupId } = context;
  const isSuperAdmin = permissions.isSuperAdmin(userId);
  const isGroupSuperAdmin = groupId
    ? permissions.isGroupSuperAdmin(userId, groupId)
    : false;
  const canModerate = groupId
    ? permissions.hasAtLeast(userId, groupId, PermissionLevel.Moderator)
    : isSuperAdmin ||
      permissions.hasAnyGroupRole(userId, PermissionLevel.Moderator);
  const canAdmin = groupId
    ? permissions.hasAtLeast(userId, groupId, PermissionLevel.GroupAdmin)
    : isSuperAdmin ||
      permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin);
  return { isSuperAdmin, isGroupSuperAdmin, canModerate, canAdmin };
}

/** 渲染指定层级的菜单；越权时返回 `ok: false` 的说明卡片。 */
export function buildMenu(section: MenuSection, context: MenuContext): MenuView {
  const access = resolveMenuAccess(context);
  const spec = buildSpec(section, context, access);
  return {
    section,
    ok: spec.ok,
    message: renderCard(spec.card),
  };
}

interface SpecResult {
  ok: boolean;
  card: CardSpec;
}

/**
 * 「未知指令」回复：保留原来的报错语义，同时附上菜单入口按钮。
 *
 * 纯文本降级由模板生成，仍然包含「未知指令」与全部可用指令，因此不支持按钮的客户端
 * 也不会失去可用性。
 */
export function buildUnknownCommandMenu(
  command: string,
  context: MenuContext,
): RichMessage {
  const access = resolveMenuAccess(context);
  const main = mainCard(context, access);
  return renderCard({
    title: "未知指令",
    lines: [
      `未知指令：${escapeCardText(command) || "（空）"}`,
      "输入 /help 查看全部指令，或使用下面的菜单。",
      "",
      ...(main.lines ?? []),
    ],
    rows: main.rows,
    buttonHint: "请选择入口：",
    footer: main.footer,
  });
}

function buildSpec(
  section: MenuSection,
  context: MenuContext,
  access: MenuAccess,
): SpecResult {
  if (!context.bound && section !== "main" && section !== "sys") {
    return denial("请先绑定 QQ 号：/bind qq <QQ号>");
  }
  switch (section) {
    case "main":
      return { ok: true, card: mainCard(context, access) };
    case "sys":
      return { ok: true, card: systemCard(context, access) };
    case "activity":
      return { ok: true, card: activityCard(context) };
    case "admin":
      if (!access.canModerate) {
        return denial("需要审核员及以上权限（/perm grant mod）。");
      }
      return { ok: true, card: adminCard(context, access) };
    case "review":
      if (!access.canAdmin) {
        return denial("需要群管理员及以上权限（/perm grant admin）。");
      }
      return { ok: true, card: reviewCard(context) };
    case "ops":
      if (!access.canAdmin) {
        return denial("需要群管理员及以上权限（/perm grant admin）。");
      }
      return { ok: true, card: opsCard(context) };
    case "super":
      // 超管菜单是平台级入口：/perm、/rules all、/whois、/bind user|groupid、/notify all
      // 都只有全局超级管理员能做；本群超管请用管理菜单。
      if (!access.isSuperAdmin) {
        return denial(
          access.isGroupSuperAdmin
            ? "本群超级管理员请使用管理菜单（/menu admin）。"
            : "需要全局超级管理员权限。",
        );
      }
      return { ok: true, card: superCard(context) };
  }
}

function denial(reason: string): SpecResult {
  return {
    ok: false,
    card: {
      title: "权限不足",
      lines: [reason],
      rows: [[backButton()]],
    },
  };
}

function mainCard(context: MenuContext, access: MenuAccess): CardSpec {
  const lines: string[] = [];
  if (context.userLabel) {
    lines.push(`**用户**：${context.userLabel}`);
  }
  lines.push(
    `**权限**：${LEVEL_LABELS[context.permissions.levelFor(context.userId, context.groupId)]}`,
  );
  if (context.groupLabel) {
    lines.push(`**当前群**：${context.groupLabel}`);
    if (context.groupBound === false) {
      lines.push("本群未绑定群号：/bind group <群号>");
    }
  } else {
    lines.push("私信中操作群功能时，请在指令里带上群号。");
  }

  const sections: CardButton[] = [button("sys", "系统菜单", "/menu sys")];
  if (access.canModerate) {
    sections.push(button("admin", "管理菜单", "/menu admin"));
  }
  if (access.isSuperAdmin) {
    sections.push(button("super", "超管菜单", "/menu super"));
  }

  const personal: CardButton[] = [button("help", "帮助", "/help")];
  if (context.bound) {
    personal.push(button("myperm", "我的权限", "/myperm"));
    personal.push(button("profile", "我的资料", "/profile"));
  } else {
    personal.push(button("bind", "绑定账号", "/bind qq 你的QQ号"));
  }

  return {
    title: "系统菜单",
    lines,
    rows: [sections, personal.slice(0, 3), ...(personal.length > 3 ? [personal.slice(3)] : [])],
    buttonHint: "请选择入口：",
    footer: ["按钮点击即发送对应指令；按钮不可用时可直接输入指令。"],
  };
}

function systemCard(context: MenuContext, access: MenuAccess): CardSpec {
  const rows: CardButton[][] = [
    [button("help", "帮助", "/help"), backButton()],
  ];
  if (context.bound) {
    rows[0]!.unshift(button("myperm", "我的权限", "/myperm"));
    rows.push([
      button("profile", "我的资料", "/profile"),
      button("activity", "活动报名", "/menu activity"),
    ]);
  } else {
    rows[0]!.unshift(button("bind", "绑定账号", "/bind qq 你的QQ号"));
  }
  if (access.canModerate) {
    rows[rows.length - 1]!.push(
      button("admin", "管理菜单", "/menu admin"),
    );
  }
  return {
    title: "系统菜单",
    lines: ["面向所有成员的能力：帮助、绑定、个人资料与活动。"],
    rows,
    buttonHint: "请选择功能：",
    footer: ["查看全部指令：/help；某个指令的详细用法：/help <指令>"],
  };
}

function activityCard(context: MenuContext): CardSpec {
  return {
    title: "活动",
    lines: [
      "活动列表：/activity",
      "活动详情：/activity info #短码",
      "报名：/activity join #短码",
      "取消报名：/activity quit #短码",
    ],
    rows: [[button("list", "活动列表", "/activity"), backButton()]],
    buttonHint: "报名与取消报名在活动卡片上有一键按钮。",
    footer: [
      "活动短码形如 #A7K2Q9，可从活动列表或活动卡片上获取。",
      "报名前需要补全个人资料：/profile",
    ],
  };
}

function adminCard(context: MenuContext, access: MenuAccess): CardSpec {
  const rows: CardButton[][] = [
    [
      button("pending", "待审批", "/pending"),
      button("sync", "同步官方", "/sync"),
      button("audit", "审计日志", "/audit"),
    ],
    [
      button("rules", "群规则", "/rules"),
      button("status", "运行状态", "/status"),
      button("test", "自检", "/test"),
    ],
  ];
  const last: CardButton[] = [];
  if (access.canAdmin) {
    last.push(button("review", "审核操作", "/menu review"));
    last.push(button("ops", "活动运营", "/menu ops"));
  }
  last.push(backButton());
  rows.push(last);

  return {
    title: "管理菜单",
    lines: [
      "群管理相关能力按权限分级显示；看不到的入口说明权限不足。",
      "审批、改规则与导出需要群管理员及以上权限。",
    ],
    rows,
    buttonHint: "请选择功能：",
    footer: ["审批需要先拿到申请ID：从 /pending 或入群推送卡片获取。"],
  };
}

function reviewCard(context: MenuContext): CardSpec {
  return {
    title: "审核操作",
    lines: [
      "申请ID 从 /pending 或推送卡片获取，短码 `#XXXXXX` 也可以。",
      "通过：/approve <申请ID>",
      "拒绝：/reject <申请ID> <原因>",
    ],
    rows: [
      [
        button("pending", "待审批", "/pending"),
        button("sync", "同步官方", "/sync"),
      ],
      [menuButton("admin", "管理菜单", "admin"), backButton()],
    ],
    buttonHint: "审批动作需要带申请ID，因此这里不提供按钮。",
    footer: ["推送卡片上的「同意 / 拒绝」按钮等价于这两条指令。"],
  };
}

function opsCard(context: MenuContext): CardSpec {
  return {
    title: "活动运营",
    lines: [
      "新建：/activity create <标题>",
      "修改：/activity set #短码 <字段> <值>",
      "开停：/activity open|close|cancel #短码",
      "名单：/activity signups #短码",
      "导出审计：/export [数量]",
    ],
    rows: [
      [
        button("list", "活动列表", "/activity"),
        button("pending", "待审批", "/pending"),
      ],
      [menuButton("admin", "管理菜单", "admin"), backButton()],
    ],
    buttonHint: "创建与修改活动需要带参数，请按上面的用法手输指令。",
  };
}

function superCard(context: MenuContext): CardSpec {
  return {
    title: "超管菜单",
    lines: [
      "平台级能力，仅全局超级管理员可用。",
      "查询映射：/whois <QQ号|userId|群号|短码|group_openid>",
      "绑定用户：/bind user <userId> <QQ号>",
      "绑定群号：/bind groupid <group_openid> <群号>",
      "授权：/perm grant super|gsuper|admin|mod ...",
      "全局规则：/rules set all <字段> <值>",
      "全局推送：/notify all on|off",
    ],
    rows: [
      [
        button("perm", "权限", "/perm list"),
        button("rules", "全局规则", "/rules all"),
        button("notify", "通知全部群", "/notify all on"),
      ],
      [button("pending", "待审批", "/pending"), backButton()],
    ],
    buttonHint: "常用入口：",
    footer: ["需要参数的指令请按上面的用法手输。"],
  };
}

function button(id: string, label: string, command: string): CardButton {
  return { id, label, command };
}

function menuButton(
  id: string,
  label: string,
  section: MenuSection,
): CardButton {
  return { id, label, command: `/menu ${section}` };
}

function backButton(): CardButton {
  return menuButton("back", "返回", "main");
}
