import { renderCard, type CardButton } from "../cardTemplate.js";
import { findHelpTopic, type HelpTopic } from "../helpTopics.js";
import { resolveMenuAccess } from "../menu.js";
import { TEST_MENU_PAGE_COUNT } from "../testMenu.js";
import { PermissionLevel } from "../../core/enums.js";
import type { AdminCommandContext } from "./context.js";
import { menuContext } from "./menuCommands.js";
import { viewButton, type CardResult, type CommandResult } from "./support.js";

/**
 * `/help` 领域模块：帮助伞形卡、完整指令列表、单个指令主题的详细用法。
 *
 * 正文文本由 `buildHelp()` 生成（纯文本降级因此与旧输出等价），
 * 卡片只负责按标准给出分类入口；权限判定沿用 `helpTopics.ts` 的 `allows`。
 */

/** `/help`、`cb:help:home`、`cb:help:list`、`cb:help:topic:<name>` 的渲染入口。 */
export function helpCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  topicQuery?: string,
): CardResult {
  const access = resolveMenuAccess(menuContext(ctx, groupId, userId));
  /** 完整指令列表卡（正文沿用 buildHelp，含未绑定/未绑群提示）。 */
  const listCard = (): CardResult => {
    const card = renderCard({
      title: "全部可用指令",
      lines: buildHelp(ctx, groupId, userId).split("\n"),
      rows: [[viewButton("home", "返回帮助", "help", "home")]],
      footer: ["某个指令的详细用法：/help <指令>"],
    });
    return { ok: true, text: card.text, rich: card };
  };
  const isBound = ctx.identityMap
    ? Boolean(ctx.identityMap.getQq(userId))
    : true;
  const groupBound =
    groupId === undefined || !ctx.identityMap
      ? true
      : Boolean(ctx.identityMap.getGroupNumber(groupId));

  if (!topicQuery) {
    // 未绑定 QQ 号 / 本群未绑定：直接给完整列表卡，正文里带绑定提示
    if (!isBound || !groupBound) {
      return listCard();
    }
    // 伞形卡：只给分类入口，完整列表在 `/help all`（避免一张卡 30 行）
    const menuRow: CardButton[] = [
      viewButton("sys", "系统菜单", "menu", "open", "sys"),
    ];
    if (access.canModerate) {
      menuRow.push(viewButton("admin", "管理菜单", "menu", "open", "admin"));
    }
    if (access.isSuperAdmin) {
      menuRow.push(viewButton("super", "超管菜单", "menu", "open", "super"));
    }
    const card = renderCard({
      title: "指令帮助",
      lines: [
        "按分类查看你有权限使用的指令。",
        "完整指令列表：/help all",
      ],
      rows: [
        menuRow,
        [
          viewButton("all", "全部指令", "help", "list"),
          viewButton("topic-rules", "群规则", "help", "topic", "rules"),
          viewButton("topic-approve", "审批", "help", "topic", "approve"),
        ],
        [
          viewButton("topic-bind", "绑定", "help", "topic", "bind"),
          viewButton("topic-menu", "菜单", "help", "topic", "menu"),
        ],
      ],
      buttonHint: "请选择分类：",
      footer: ["某个指令的详细用法：/help <指令>"],
    });
    return { ok: true, text: card.text, rich: card };
  }

  if (topicQuery === "all" || topicQuery === "全部") {
    return listCard();
  }

  const topic = findHelpTopic(topicQuery);
  if (!topic) {
    const card = renderCard({
      title: "指令帮助",
      lines: [
        `未找到「${topicQuery}」的帮助。`,
        "用法：/help <指令>，例如 /help rules、/help bind、/help perm",
        "",
        ...buildHelp(ctx, groupId, userId).split("\n"),
      ],
      rows: [[viewButton("home", "返回帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  const context = {
    permissions: ctx.permissions,
    configStore: ctx.configStore,
    identityMap: ctx.identityMap,
    groupId,
    userId,
  };
  if (!topic.allows(context)) {
    const card = renderCard({
      title: "权限不足",
      lines: [
        `/${topic.name} 需要${topic.requirement}。`,
        "权限由全局超级管理员通过 /perm 配置。",
      ],
      rows: [[viewButton("home", "返回帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  const rows: CardButton[] = [viewButton("home", "返回帮助", "help", "home")];
  if (topic.name === "rules" && groupId) {
    rows.unshift(
      viewButton("view", "查看当前规则", "rules", "view", groupId),
    );
  }
  if (topic.name === "menu") {
    rows.unshift(viewButton("menu", "打开菜单", "menu", "open", "main"));
  }
  const card = renderCard({
    title: `/${topic.name} · ${topic.title}`,
    lines: renderHelpTopic(topic, context).split("\n"),
    rows: [rows],
    buttonHint: "相关入口：",
  });
  return { ok: true, text: card.text, rich: card };
}

/** `/help <指令>` 指令入口（门面 dispatch 调用）。 */
export function handleHelp(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): CommandResult {
  return helpCard(ctx, groupId, userId, parts[1]);
}

/** 单个帮助主题的纯文本正文（`/help <指令>` 与卡片正文共用）。 */
function renderHelpTopic(
  topic: HelpTopic,
  context: Parameters<HelpTopic["body"]>[0],
): string {
  return [
    `/${topic.name} — ${topic.title}`,
    `所需权限：${topic.requirement}`,
    "",
    ...topic.body(context),
    "",
    "相关：/help 查看全部可用指令",
  ].join("\n");
}

/** 完整指令列表的纯文本（按查看者权限与绑定状态动态裁剪）。 */
function buildHelp(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
): string {
  const lines: string[] = [
    "可用指令：",
    "/help - 显示帮助",
    "/help <指令> - 查看某个指令的详细用法，例如 /help rules、/help bind、/help perm",
    "/menu - 打开系统菜单（系统 / 管理 / 超管），按钮点击即执行",
    "/bind qq <QQ号> - 绑定自己的 QQ 号",
  ];
  const isSuper = ctx.permissions.isSuperAdmin(userId);
  const canBindGroup =
    groupId !== undefined &&
    (isSuper || ctx.permissions.canApproveJoin(userId, groupId));
  if (canBindGroup) {
    lines.push("/bind group <群号> - 绑定当前群号");
  }
  if (isSuper) {
    lines.push("/bind user <userId> <QQ号> - 绑定任意用户");
    lines.push("/bind groupid <group_openid> <群号> - 绑定任意群");
    lines.push("/whois <QQ号|userId|群号|group_openid> - 查询映射");
    lines.push(
      `/testmenu [页码] - 回调按钮翻页试验（1-${TEST_MENU_PAGE_COUNT} 页）`,
    );
  }

  const isBound = ctx.identityMap
    ? Boolean(ctx.identityMap.getQq(userId))
    : true;
  if (!isBound) {
    lines.push("", "请先绑定 QQ 号：/bind qq <QQ号>");
    lines.push("绑定后使用 /help 查看可用指令。");
    return lines.join("\n");
  }

  const groupBound = groupId !== undefined
    ? Boolean(ctx.identityMap?.getGroupNumber(groupId))
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
  lines.push("/profile - 配置个人资料（班级/学院/姓名/学号）");
  lines.push("/activity - 活动列表；/activity join <#活动短码> 报名");
  const canModerate =
    groupId !== undefined
      ? ctx.permissions.canReviewContent(userId, groupId)
      : ctx.permissions.hasAnyGroupRole(userId, PermissionLevel.Moderator);
  const canAdmin =
    groupId !== undefined
      ? ctx.permissions.canApproveJoin(userId, groupId)
      : ctx.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin);

  if (canModerate) {
    lines.push("/pending [#群短码|群号] - 查看待审批入群申请");
    lines.push("/sync [#群短码|群号] - 从官方接口同步待审批申请");
    lines.push("/rules [#群短码|群号] - 查看群规则配置");
    lines.push("/audit [#群短码|群号] [数量] - 查看最近审计记录");
    lines.push("/status [#群短码|群号] - 查看群运行状态");
    lines.push("/test - 测试机器人是否正常响应");
  }
  if (canAdmin) {
    lines.push("/approve [#群短码|群号] <申请ID> - 通过入群申请");
    lines.push("/reject [#群短码|群号] <申请ID> [原因] - 拒绝入群申请");
    lines.push("/notify - 配置入群申请推送（卡片 + 快捷同意/拒绝按钮）");
    lines.push("/rules set <字段> <值> - 修改群规则（关键词、警告文案等）");
  }
  if (isSuper) {
    lines.push("/perm list [#群短码|群号] - 查看权限配置");
    lines.push("/perm grant super <userId|QQ号> - 授予全局超管");
    lines.push("/perm revoke super <userId|QQ号> - 撤销全局超管");
    lines.push("/perm grant gsuper [#群短码|群号] <userId|QQ号> - 授予本群超管");
    lines.push("/perm revoke gsuper [#群短码|群号] <userId|QQ号> - 撤销本群超管");
    lines.push("/perm grant admin [#群短码|群号] <userId|QQ号> - 授予群管理员");
    lines.push("/perm revoke admin [#群短码|群号] <userId|QQ号> - 撤销群管理员");
    lines.push("/perm grant mod [#群短码|群号] <userId|QQ号> - 授予审核员");
    lines.push("/perm revoke mod [#群短码|群号] <userId|QQ号> - 撤销审核员");
    lines.push("/rules all - 查看全局默认规则");
    lines.push("/rules set all <字段> <值> - 修改全局默认规则");
  }
  if (!canModerate && !canAdmin && !isSuper) {
    lines.push("当前没有更多可执行的管理指令。");
  }
  return lines.join("\n");
}
