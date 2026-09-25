import { PermissionLevel } from "../core/enums.js";
import { encodeCallback } from "./callbackData.js";
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

  const sections: CardButton[] = [menuButton("sys", "系统菜单", "sys")];
  if (access.canModerate) {
    sections.push(menuButton("admin", "管理菜单", "admin"));
  }
  if (access.isSuperAdmin) {
    sections.push(menuButton("super", "超管菜单", "super"));
  }

  const personal: CardButton[] = [cmdButton("help", "帮助", "/help")];
  if (context.bound) {
    personal.push(cmdButton("myperm", "我的权限", "/myperm"));
    personal.push(cmdButton("profile", "我的资料", "/profile"));
  } else {
    personal.push(button("bind", "绑定账号", "/bind qq 你的QQ号"));
  }

  return {
    title: "系统菜单",
    lines,
    rows: [sections, personal.slice(0, 3), ...(personal.length > 3 ? [personal.slice(3)] : [])],
    buttonHint: "请选择入口：",
  };
}

function systemCard(context: MenuContext, access: MenuAccess): CardSpec {
  const rows: CardButton[][] = [
    [cmdButton("help", "帮助", "/help"), backButton()],
  ];
  if (context.bound) {
    rows[0]!.unshift(cmdButton("myperm", "我的权限", "/myperm"));
    rows.push([
      cmdButton("profile", "我的资料", "/profile"),
      menuButton("activity", "活动", "activity"),
    ]);
  } else {
    rows[0]!.unshift(button("bind", "绑定账号", "/bind qq 你的QQ号"));
  }
  if (access.canModerate) {
    rows[rows.length - 1]!.push(
      menuButton("admin", "管理菜单", "admin"),
    );
  }
  return {
    title: "系统菜单",
    lines: ["面向所有成员的能力：帮助、绑定、个人资料与活动。"],
    rows,
    buttonHint: "请选择功能：",
  };
}

function activityCard(context: MenuContext): CardSpec {
  return {
    title: "活动",
    lines: [
      "活动列表：/activity（按「报名中 / 草稿 / 已结束」分组）",
      "活动详情：/activity info #短码",
      "报名：/activity join #短码",
      "取消报名：/activity quit #短码",
      "订阅新活动：/activity subscribe（发布时私信给你）",
    ],
    rows: [[cmdButton("list", "活动列表", "/activity"), backButton()]],
    buttonHint: "报名与取消报名在活动卡片上有一键按钮。",
    footer: [
      "活动短码形如 #A7K2Q9，可从活动列表或活动卡片上获取。",
      "报名前需要补全个人资料：/profile",
      "订阅只推送新活动，不发群消息（机器人无法 @全体成员）。",
    ],
  };
}

function adminCard(context: MenuContext, access: MenuAccess): CardSpec {
  const rows: CardButton[][] = [
    [
      cmdButton("pending", "待审批", "/pending"),
      cmdButton("sync", "同步", "/sync"),
      cmdButton("audit", "审计", "/audit"),
    ],
    [
      cmdButton("rules", "群规则", "/rules"),
      cmdButton("status", "状态", "/status"),
      cmdButton("test", "自检", "/test"),
    ],
  ];
  const last: CardButton[] = [];
  if (access.canAdmin) {
    last.push(menuButton("review", "审核操作", "review"));
    last.push(menuButton("ops", "活动运营", "ops"));
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
        cmdButton("pending", "待审批", "/pending"),
        cmdButton("sync", "同步", "/sync"),
      ],
      [menuButton("admin", "管理菜单", "admin"), backButton()],
    ],
    buttonHint: "审批动作需要带申请ID，因此这里不提供按钮。",

  };
}

function opsCard(context: MenuContext): CardSpec {
  return {
    title: "活动运营",
    lines: [
      "新建：/activity create <标题>（自动返回配置卡）",
      "修改：/activity set #短码 <字段> <值>",
      "开停：/activity open|close|cancel #短码",
      "名单：/activity signups #短码 [+页码] [full]",
      "管理卡：报名名单 / 释放名额 / 重发卡片 / 开关报名",
      "导出审计：/export [数量]",
    ],
    rows: [
      [
        cmdButton("list", "活动列表", "/activity"),
        cmdButton("pending", "待审批", "/pending"),
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
      "班级别名：/alias set <别名> <规范名>",
      "@ 自检：/testat（群内测 @ 是否生效，/testat all 测 @全体）",
    ],
    rows: [
      [
        cmdButton("perm", "权限", "/perm list"),
        cmdButton("globalRules", "全局规则", "/rules all"),
        cmdButton("alias", "别名表", "/alias"),
      ],
      [
        cmdButton("notify", "通知订阅", "/notify"),
        cmdButton("testmenu", "翻页测试", "/testmenu"),
        cmdButton("testat", "@测试", "/testat"),
      ],
      [cmdButton("pending", "待审批", "/pending"), backButton()],
    ],
    buttonHint: "常用入口：",
  };
}

/** 需要参数的指令：仍然用指令按钮（点击=把指令填进输入框，用户补参数后发送）。 */
function button(id: string, label: string, command: string): CardButton {
  return { id, label, command };
}

/** 固定指令入口：用回调自动执行（标准：无需参数的固定动作走回调）。 */
function cmdButton(id: string, label: string, command: string): CardButton {
  return { id, label, callbackData: encodeCallback("cmd", "run", command) };
}

/** 菜单导航：用回调直接打开某个菜单层级。 */
function menuButton(
  id: string,
  label: string,
  section: MenuSection,
): CardButton {
  return { id, label, callbackData: encodeCallback("menu", "open", section) };
}

function backButton(): CardButton {
  return menuButton("back", "返回", "main");
}
