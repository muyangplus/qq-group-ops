import { getLogger } from "../../core/logger.js";
import {
  ActivityRuleError,
  type Activity,
  type ActivityWaitlistEntry,
} from "../activity.js";
import {
  ActivityCardService,
  type ActivityCardInput,
  code as activityCode,
  formatCloseAt,
} from "../activityCards.js";
import type { ActivityNotificationService } from "../activityNotifications.js";
import { extractPageToken } from "../callbackData.js";
import {
  escapeCardText,
  renderCard,
  type CardButton,
} from "../cardTemplate.js";
import type { AdminCommandContext } from "./context.js";
import {
  type CardResult,
  type CommandResult,
  mention,
  actionButton,
  ACTIVITY_NOTIFY_FIELDS,
  ACTIVITY_SET_USAGE,
  ACTIVITY_USAGE,
  cardFromText,
  CLEAR_WORDS,
  formatError,
  formatGroupList,
  listGroupOf,
  normalize,
  parseCloseAt,
  parseLink,
  parseLinks,
  parseList,
  parsePositiveInt,
  parseSignupPage,
  parseToggle,
  parseYearList,
  TOGGLE_OFF,
  TOGGLE_ON,
  viewButton,
} from "./support.js";
import { resolveTargetGroupId } from "./targetResolvers.js";
import type { RichMessage } from "../richMessages.js";
import {
  UserProfileError,
  type UserProfile,
} from "../userProfiles.js";

/**
 * §B4 落地选项：报名 / 取消报名的结果**只私信**。
 *
 * - `dmOnly: true` 表示「结果私信给本人，群里不发结果」；
 * - `dmSilent: true` 表示命令路径（`silent: true`，跳过群回复）；
 *   回调路径为 `false`（命中静默时渲染器不发言）；
 * - 群内与私聊都走同一套 handler，私聊传 `dmOnly: false` 原地回复。
 */
export interface ActivityDmOptions {
  dmOnly: boolean;
  dmSilent: boolean;
}

/**
 * 活动域：列表 / 详情 / 发布 / 报名与候补 / 绑定群 / 统计导出 / 通知推送。
 *
 * 门面 `AdminCommandService` 保留公开卡片方法（薄包装）；
 * 需留在门面的实例态（`fallbackSubscriptions`、`cardSender()`）通过 `ctx.helpers` 暴露。
 */

const log = getLogger("admin-commands");

/**
 * `/activity [list] [群号] [+页码]`：活动列表卡（按状态分组）。
 *
 * 每页 3 个活动，每个活动一行按钮：`详情` / `报名` / `管理`（仅管理者）/ `订阅`，
 * 全部是**回调**（点击即出卡/生效，不用再发消息）；翻页是回调，
 * 纯文本降级给出 `/activity list +<页码>`（`+` 前缀与群号区分）。
 */
export function activityListCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  page = 1,
  notice?: string,
): CardResult {
  const list = ctx.activity!.listActivities(targetGroupId);
  const groupLabel = ctx.helpers.displayGroup(targetGroupId);
  if (list.length === 0) {
    return cardFromText(
      "活动列表",
      [...ctx.helpers.renderNotice(notice), `群 ${groupLabel} 还没有活动。`].join("\n"),
      {
        rows: [
          [viewButton("refresh", "刷新", "activity", "page", targetGroupId, 1)],
        ],
        footer: [
          "创建活动：/activity create <标题>（群管理员或以上）",
          `本群：${groupLabel}`,
        ],
      },
    );
  }

  const size = 3;
  const pageCount = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(page, 1), pageCount);
  const slice = list.slice((current - 1) * size, current * size);
  const subscribed = isSubscribedTo(ctx, targetGroupId, userId);
  const canManageAny = list.some((activity) =>
    canManageActivity(ctx, userId, activity),
  );
  const lines = [
    ...ctx.helpers.renderNotice(notice),
    `**群**：${groupLabel}`,
    `**活动**：${list.length} 个 · 第 ${current} / ${pageCount} 页`,
    "",
  ];
  const rows: CardButton[][] = [];
  for (const groupName of ["报名中", "草稿", "已结束"] as const) {
    const group = slice.filter((activity) => listGroupOf(activity) === groupName);
    if (group.length === 0) {
      continue;
    }
    lines.push(`**${groupName}**`);
    for (const activity of group) {
      const count = ctx.activity!.listRegistrations(activity.activityId).length;
      const code = activityCode(activity);
      lines.push(
        `${escapeCardText(code)} ${escapeCardText(activity.title)} · 报名 ${count}${
          activity.capacity ? `/${activity.capacity}` : ""
        }`,
      );
      const row: CardButton[] = [
        viewButton(`info-${code}`, "详情", "activity", "info", code),
        viewButton(`join-${code}`, "报名", "activity", "join", code),
      ];
      if (canManageActivity(ctx, userId, activity)) {
        row.push(viewButton(`manage-${code}`, "管理", "activity", "manage", code));
      }
      row.push(
        viewButton(
          `subscribe-${code}`,
          subscribed ? "订阅 开" : "订阅 关",
          "activity",
          "subscribe",
          targetGroupId,
          subscribed ? "off" : "on",
        ),
      );
      rows.push(row);
    }
    lines.push("");
  }

  const paging: CardButton[] = [];
  if (current > 1) {
    paging.push(
      viewButton("prev", "上一页", "activity", "page", targetGroupId, current - 1),
    );
  }
  if (current < pageCount) {
    paging.push(
      viewButton("next", "下一页", "activity", "page", targetGroupId, current + 1),
    );
  }
  paging.push(
    viewButton("refresh", "刷新", "activity", "page", targetGroupId, current),
  );
  rows.push(paging);

  const footer: string[] = [];
  if (current < pageCount) {
    footer.push(`下一页：/activity list +${current + 1}`);
  }
  if (current > 1) {
    footer.push(`上一页：/activity list +${current - 1}`);
  }
  if (canManageAny) {
    footer.push("管理入口只在你有权限的活动上显示。");
  }

  return cardFromText("活动列表", lines.join("\n"), {
    rows,
    buttonHint: "点击操作：",
    footer,
  });
}

export async function handleActivity(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const activities = ctx.activity;
  if (!activities) {
    return { ok: false, text: "活动模块未启用。" };
  }
  const action = normalize(parts[1]);
  if (!action || action === "list" || action === "列表" || action === "查看") {
    const { page, rest } = extractPageToken(parts);
    const targetGroupId =
      ctx.helpers.resolveTargetGroupId(groupId, rest[1] ?? rest[0]) ?? groupId;
    if (!targetGroupId) {
      return {
        ok: false,
        text: "用法：/activity（群内查看本群活动），或 /activity list <群号|#群短码> [+页码]",
      };
    }
    return activityListCard(ctx, targetGroupId, userId, page);
  }
  if (parts[1]?.startsWith("#")) {
    return handleActivityInfo(ctx, userId, parts[1]);
  }
  switch (action) {
    case "create":
    case "创建":
    case "新建":
      return handleActivityCreate(ctx, groupId, userId, parts);
    case "set":
    case "设置":
    case "配置":
      return handleActivitySet(ctx, userId, parts, groupId);
    case "open":
    case "开始":
    case "发布":
      return handleActivityOpen(ctx, userId, parts, groupId);
    case "close":
    case "关闭":
      return handleActivityStatus(ctx, userId, parts, "close", groupId);
    case "cancel":
    case "取消活动":
      return handleActivityStatus(ctx, userId, parts, "cancel", groupId);
    case "join":
    case "报名":
      return handleActivityJoin(ctx, groupId, userId, parts);
    case "quit":
    case "取消报名":
      return handleActivityQuit(ctx, groupId, userId, parts);
    case "info":
    case "详情":
      return handleActivityInfo(ctx, userId, parts[2]);
    case "signups":
    case "名单":
      return handleActivitySignups(ctx, userId, parts, groupId);
    case "subscribe":
    case "订阅":
      return subscribeCard(ctx, groupId, userId, parts[2]);
    case "bind":
    case "绑定群":
      return handleActivityBindCommand(ctx, userId, parts);
    case "unbind":
    case "解绑群":
      return handleActivityUnbindCommand(ctx, userId, parts);
    case "unsubscribe":
    case "退订":
      return subscribeCard(ctx, groupId, userId, parts[2], false);
    case "manage":
    case "管理":
      return activityManageCard(ctx, userId, parts[2]);
    case "config":
      return activityConfigCard(ctx, userId, parts[2]);
    default:
      return { ok: false, text: ACTIVITY_USAGE };
  }
}

// ------------------------------------------- 活动：卡片构造（B2）

/** 统一构造活动卡片输入（补齐名单 / 候补 / 展示群名 / 查看者权限）。 */
export function activityCardInput(
  ctx: AdminCommandContext,
  activity: Activity,
  userId: string,
  extra: { full?: boolean; page?: number } = {},
): ActivityCardInput {
  const registrations = ctx.activity!.listRegistrations(activity.activityId);
  return {
    activity,
    registrations,
    waitlist: ctx.activity!.listWaitlist(activity.activityId),
    boundGroups: ctx.activity!.listBoundGroups(activity.activityId),
    groupLabel: activity.groupNumber || ctx.helpers.displayGroup(activity.groupId),
    viewerId: userId,
    canManage: canManageActivity(ctx, userId, activity),
    ...extra,
  };
}

export function activityCardService(ctx: AdminCommandContext): ActivityCardService {
  const cards = ctx.activityCards;
  if (cards) {
    return cards;
  }
  // 未装配卡片服务时（极简单测）用最小依赖现建一个，保证活动指令仍是卡片。
  return new ActivityCardService({
    activity: ctx.activity,
    display: ctx.display,
    // 绑定群子卡：群里显示绑定号 / 短码，不暴露 openid
    groupLabel: (groupId) => ctx.helpers.displayGroup(groupId),
    ...(ctx.userProfiles ? { profiles: ctx.userProfiles } : {}),
    ...(ctx.helpers.roster() ? { roster: ctx.helpers.roster() } : {}),
    // 「统计图片」按钮只在**既能渲染又能发送**时生成，避免出现点了没反应的入口
    ...(ctx.helpers.statsService()?.canSend
      ? { stats: ctx.helpers.statsService() }
      : {}),
    ...(ctx.helpers.exportService()
      ? { exportService: ctx.helpers.exportService() }
      : {}),
    isSubscribed: (groupId, id) => isSubscribedTo(ctx, groupId, id),
  });
}

export function isSubscribedTo(ctx: AdminCommandContext, groupId: string, userId: string): boolean {
  if (ctx.activityNotifications) {
    return ctx.activityNotifications.isSubscribed(groupId, userId);
  }
  return ctx.helpers.fallbackSubscriptions.has(`${groupId}\u0000${userId}`);
}

/**
 * 订阅开关（`cb:activity:subscribe` / `/activity subscribe`）：任意成员可切换。
 *
 * 订阅是**按群**的：只在发布新活动时给订阅者私信，不发群消息（主动消息有限额）。
 */
export function subscribeCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  rawTarget?: string,
  enabled?: boolean,
): CardResult {
  const targetGroupId =
    rawTarget !== undefined && rawTarget.length > 0
      ? (ctx.helpers.resolveTargetGroupId(undefined, rawTarget) ?? rawTarget)
      : groupId;
  if (!targetGroupId) {
    const card = renderCard({
      title: "新活动订阅",
      lines: [
        "该指令需要在群内使用，或在私信中带上群号 / #群短码。",
        "用法：/activity subscribe <群号|#群短码>；/activity unsubscribe",
      ],
      rows: [[viewButton("help", "指令帮助", "help", "topic", "activity")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  const subscribed = isSubscribedTo(ctx, targetGroupId, userId);
  const next = enabled ?? (rawTarget === undefined ? !subscribed : true);
  const changed = next !== subscribed;
  if (changed) {
    if (next) {
      if (ctx.activityNotifications) {
        ctx.activityNotifications.subscribe(targetGroupId, userId);
      } else {
        ctx.helpers.fallbackSubscriptions.add(`${targetGroupId}\u0000${userId}`);
      }
    } else if (ctx.activityNotifications) {
      ctx.activityNotifications.unsubscribe(targetGroupId, userId);
    } else {
      ctx.helpers.fallbackSubscriptions.delete(`${targetGroupId}\u0000${userId}`);
    }
    log.info("activity subscription toggled", {
      groupId: targetGroupId,
      userId,
      subscribed: next,
    });
  }
  const groups = ctx.activityNotifications
    ? ctx.activityNotifications.listSubscribedGroups(userId)
    : [...ctx.helpers.fallbackSubscriptions]
        .map((key) => key.split("\u0000")[0] ?? "")
        .filter((id) => id.length > 0);
  const lines = [
    `**本群**：${ctx.helpers.groupLabel(targetGroupId)}`,
    `**订阅状态**：${next ? "已订阅" : "未订阅"}`,
    changed ? `**结果**：已${next ? "订阅" : "取消订阅"}新活动通知` : "**结果**：订阅状态未变化",
    "",
    "订阅后：该群发布新活动时会私信发你一张活动卡；不会再往群里发通知。",
    groups.length > 0
      ? `**已订阅的群**：${groups.map((id) => ctx.helpers.groupLabel(id)).join("、")}`
      : "**已订阅的群**：无",
    "",
    "说明：机器人无法 @全体成员；主动私信有人数限额，因此只推送给订阅者与当事人。",
  ];
  return cardFromText("新活动订阅", lines.join("\n"), {
    rows: [
      [
        viewButton(
          "toggle",
          next ? "订阅 开" : "订阅 关",
          "activity",
          "subscribe",
          targetGroupId,
          next ? "off" : "on",
        ),
        viewButton("help", "订阅帮助", "help", "topic", "activity"),
      ],
    ],
    buttonHint: "点击切换：",
  });
}

/** 管理卡入口（管理者专用）。 */
export function activityManageCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "需要群管理员或活动发布者权限。");
  }
  return {
    ok: true,
    text: activityCardService(ctx)
      .manageCard(activityCardInput(ctx, activity, userId))
      .markdown,
    rich: activityCardService(ctx).manageCard(activityCardInput(ctx, activity, userId)),
  };
}

/** 配置卡入口（管理者专用）。 */
export function activityConfigCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "需要群管理员或活动发布者权限。");
  }
  const rich = activityCardService(ctx).configCard(
    activityCardInput(ctx, activity, userId),
  );
  return { ok: true, text: rich.text, rich };
}

/** 活动不存在的统一卡片（回调里短码解析失败也走这里）。 */
export function activityNotFoundCard(ctx: AdminCommandContext, rawCode: string): CardResult {
  const card = renderCard({
    title: "活动不存在",
    lines: [
      `没有找到活动：${escapeCardText(rawCode) || "（空短码）"}`,
      "短码形如 #A7K2Q9，可从活动列表或活动卡片上复制。",
    ],
    rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
  });
  return { ok: false, text: card.text, rich: card };
}

export function activityDeniedCard(ctx: AdminCommandContext, reason: string): CardResult {
  const card = renderCard({
    title: "权限不足",
    lines: [reason],
    rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
  });
  return { ok: false, text: card.text, rich: card };
}

/** 活动成员卡（群内展示 / 预览 / 重发）。 */
export function activityMemberCard(ctx: AdminCommandContext, activity: Activity, viewerId: string): RichMessage {
  return activityCardService(ctx).memberCard(
    activityCardInput(ctx, activity, viewerId),
  );
}

// ------------------------------------------- 活动：回调 renderer（B2）

/**
 * `cb:activity:*` 的总入口。
 *
 * 每个 action 在这里**重新做权限校验**（不能信按钮）：
 * - 报名 / 取消报名 / 订阅 = 任意成员；
 * - 配置 / 发布 / 关停 / 释放 / 名单 / 导出 / 统计 = `canManageActivity` 或超管；
 * - 名单 / 统计 / 导出在各自 handler 里再校验一次。
 *
 * `replyGroupId` 是**用户点击所在的群**（私聊点击时为 undefined），用于决定
 * 回执落在群里还是私聊 —— 隐私字段只在私聊出现（用户确认的落点）。
 *
 * 返回 `undefined` 表示「这个回调不该产生消息」（§B4 群内静默：结果已经私信出去）。
 */
export async function activityCallbackCard(
  ctx: AdminCommandContext,
  action: string,
  args: readonly string[],
  userId: string,
  replyGroupId?: string,
): Promise<CardResult | undefined> {
  if (!ctx.activity) {
    return activityDeniedCard(ctx, "活动模块未启用。");
  }
  switch (action) {
    case "join": {
      // §B4：群里点「我要报名」→ 结果只私信，群内静默（renderer 返回 undefined）。
      // 回调路径用 `dmSilent: false`，因此「已私信成功」= 返回 undefined；
      // 只有私信失败时才会拿到一张**不含结果**的兜底卡。
      if (replyGroupId !== undefined) {
        const silentResult = await joinActivityCard(ctx, replyGroupId, userId, [
          "activity",
          "join",
          args[0] ?? "",
        ], { dmOnly: true, dmSilent: false });
        // undefined = 已私信成功（群内静默）；兜底提示卡要发到群里
        return silentResult;
      }
      return joinActivityCard(ctx, undefined, userId, ["activity", "join", args[0] ?? ""], {
        dmOnly: false,
        dmSilent: false,
      });
    }
    case "quit": {
      // §B4：群里点「取消报名」→ 结果只私信，群内静默
      if (replyGroupId !== undefined) {
        const silentResult = await quitActivityCard(ctx, replyGroupId, userId, [
          "activity",
          "quit",
          args[0] ?? "",
        ], { dmOnly: true, dmSilent: false });
        // undefined = 已私信成功（群内静默）；兜底提示卡要发到群里
        return silentResult;
      }
      return quitActivityCard(ctx, undefined, userId, ["activity", "quit", args[0] ?? ""], {
        dmOnly: false,
        dmSilent: false,
      });
    }
    case "info":
      return activityInfoCard(ctx, userId, args[0]);
    case "signups":
      return handleActivitySignups(ctx,
        userId,
        ["activity", "signups", args[0] ?? "", args[2] ? "full" : ""],
        replyGroupId,
        { page: Number.parseInt(args[1] ?? "1", 10) || 1, full: args[2] === "full" },
      );
    case "page":
      return activityListCard(ctx,
        args[0] ?? replyGroupId ?? "",
        userId,
        Number.parseInt(args[1] ?? "1", 10) || 1,
      );
    case "config":
      return activityConfigCard(ctx, userId, args[0]);
    case "manage":
      return activityManageCard(ctx, userId, args[0]);
    case "preview":
      return activityPreviewCard(ctx, userId, args[0]);
    case "bindings":
      return handleActivityBindingsCard(ctx, userId, args[0], args[1]);
    case "bind":
      return handleActivityBindInstruction(ctx, userId, args[0]);
    case "unbind":
      return handleActivityUnbind(ctx, userId, args[0], args[1], args[2]);
    case "open":
      return handleActivityOpen(ctx,
        userId,
        ["activity", "open", args[0] ?? ""],
        replyGroupId,
      );
    case "cancel":
      return handleActivityStatus(ctx,
        userId,
        ["activity", "cancel", args[0] ?? ""],
        "cancel",
        replyGroupId,
      );
    case "release":
      return handleActivityRelease(ctx, userId, args[0], replyGroupId);
    case "resend":
      return handleActivityResend(ctx, userId, args[0], replyGroupId);
    case "status":
      return handleActivityStatus(ctx,
        userId,
        ["activity", args[1] === "open" ? "open" : "close", args[0] ?? ""],
        args[1] === "open" ? "open" : "close",
        replyGroupId,
      );
    case "set":
      return handleActivitySetCallback(ctx,
        userId,
        args[0],
        args[1],
        args[2],
        replyGroupId,
      );
    case "college":
    case "year":
      return handleActivityRuleToggle(ctx,
        action,
        userId,
        args[0],
        args[1],
        Number.parseInt(args[2] ?? "1", 10) || 1,
        args[3],
        replyGroupId,
      );
    case "subscribe":
      return subscribeCard(ctx,
        replyGroupId,
        userId,
        args[0],
        args[1] === "on" ? true : args[1] === "off" ? false : undefined,
      );
    case "stats":
      return handleActivityStats(ctx, userId, args[0], replyGroupId);
    case "export":
      return handleActivityExport(ctx, userId, args[0], replyGroupId);
    default: {
      const card = renderCard({
        title: "活动操作",
        lines: [
          `不认识的按钮动作：${escapeCardText(action) || "（空）"}`,
          "请重新打开活动卡片再操作。",
        ],
        rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
  }
}

/** `cb:activity:info:<短码>`：详情卡（含查看者自己的权限入口）。 */
export function activityInfoCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const activity = found.activity;
  const registrations = ctx.activity!.listRegistrations(activity.activityId);
  const canManage = canManageActivity(ctx, userId, activity);
  const registration = ctx.activity!.findRegistration(activity.activityId, userId);
  const waitlist = ctx.activity!.findWaitlistEntry(activity.activityId, userId);
  const lines = [
    `**状态**：${activity.status}`,
    `**群**：${activity.groupNumber || ctx.helpers.displayGroup(activity.groupId)}`,
    `**报名**：${registrations.length}${activity.capacity ? ` / ${activity.capacity}` : ""}${
      activity.heldSlots > 0 ? `（待释放 ${activity.heldSlots}）` : ""
    }`,
    `**候补**：${ctx.activity!.listWaitlist(activity.activityId).length}`,
    registration ? "**你的状态**：已报名" : waitlist ? `**你的状态**：候补第 ${ctx.activity!.waitlistPosition(activity.activityId, userId) ?? 0} 位` : "**你的状态**：未报名",
  ];
  if (activity.description) {
    lines.push("", escapeCardText(activity.description));
  }
  const row: CardButton[] = [
    viewButton("join", "我要报名", "activity", "join", activityCode(activity)),
    viewButton("quit", "取消报名", "activity", "quit", activityCode(activity)),
  ];
  const card = renderCard({
    title: `活动详情 ${activityCode(activity)}`,
    lines,
    rows: [
      row,
      canManage
        ? [
            viewButton("manage", "管理", "activity", "manage", activityCode(activity)),
            viewButton("config", "配置", "activity", "config", activityCode(activity)),
          ]
        : [
            viewButton(
              "subscribe",
              isSubscribedTo(ctx, activity.groupId, userId) ? "订阅 开" : "订阅 关",
              "activity",
              "subscribe",
              activity.groupId,
              isSubscribedTo(ctx, activity.groupId, userId) ? "off" : "on",
            ),
          ],
    ],
    buttonHint: "点击操作：",
    footer: [
      `报名：/activity join ${activityCode(activity)}`,
      `报名名单：/activity signups ${activityCode(activity)}（管理者）`,
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

/** `cb:activity:bindings:<短码>[:<页码>]`：绑定群子卡（管理者专用）。 */
export function handleActivityBindingsCard(
  ctx: AdminCommandContext,
  userId: string,
  rawCode?: string,
  rawPage?: string,
): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "管理绑定群需要群管理员或活动发布者权限。");
  }
  const rich = activityCardService(ctx).bindGroupsCard({
    activity,
    groups: ctx.activity!.listBoundGroups(activity.activityId),
    page: Number.parseInt(rawPage ?? "1", 10) || 1,
  });
  return { ok: true, text: rich.text, rich };
}

/** `cb:activity:bind:<短码>`：绑定是自由文本动作 → 回一张预填指令的卡。 */
export function handleActivityBindInstruction(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "管理绑定群需要群管理员或活动发布者权限。");
  }
  const rich = activityCardService(ctx).bindGroupsCard({
    activity,
    groups: ctx.activity!.listBoundGroups(activity.activityId),
  });
  const code = activityCode(activity);
  const card = renderCard({
    title: `绑定群 ${code}`,
    lines: [
      "点下方「绑定群」会把指令填进输入框，补上群号或 #群短码再发送即可。",
      "",
      ...rich.markdown.split("\n"),
    ],
    rows: [
      [
        actionButton("bind", "绑定群", `/activity bind ${code} `),
        viewButton("back", "返回配置", "activity", "config", code),
      ],
    ],
    footer: [
      `绑定：/activity bind ${code} <群号|#群短码>`,
      `解绑：/activity unbind ${code} <群号|#群短码>`,
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

/** `cb:activity:unbind:<短码>:<群ID>:<页码>`：解绑固定动作，点一下就生效。 */
export function handleActivityUnbind(
  ctx: AdminCommandContext,
  userId: string,
  rawCode?: string,
  rawGroupId?: string,
  rawPage?: string,
): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "管理绑定群需要群管理员或活动发布者权限。");
  }
  if (!rawGroupId) {
    return activityDeniedCard(ctx, "回调参数不完整，请重新打开绑定群卡片。");
  }
  const removed = ctx.activity!.unbindGroup(activity.activityId, rawGroupId);
  const groups = ctx.activity!.listBoundGroups(activity.activityId);
  const rich = activityCardService(ctx).bindGroupsCard({
    activity,
    groups,
    page: Number.parseInt(rawPage ?? "1", 10) || 1,
  });
  const body = removed
    ? `**结果**：已解绑 ${ctx.helpers.displayGroup(rawGroupId)}。`
    : `**结果**：${ctx.helpers.displayGroup(rawGroupId)} 本来就没有绑定（可能已经被解绑）。`;
  const card = renderCard({
    title: `绑定群 ${activityCode(activity)}`,
    lines: [body, "", ...rich.markdown.split("\n")],
    rows: [
      [
        actionButton("bind", "绑定群", `/activity bind ${activityCode(activity)} `),
        viewButton("back", "返回配置", "activity", "config", activityCode(activity)),
      ],
    ],
    footer: [
      `解绑：/activity unbind ${activityCode(activity)} <群号|#群短码>`,
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

/** `/activity bind <#短码> <群号|#群短码>`：绑定发布 / 广播目标群。 */
export function handleActivityBindCommand(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
): CardResult {
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "绑定群需要群管理员或活动发布者权限。");
  }
  const targetGroupId = resolveActivityGroupArg(ctx, parts[3]);
  if (!targetGroupId) {
    return activityDeniedCard(ctx,
      `请提供群号或 #群短码：/activity bind ${activityCode(activity)} <群号|#群短码>`,
    );
  }
  const added = ctx.activity!.bindGroup(activity.activityId, targetGroupId);
  log.info("activity group binding changed", {
    activityId: activity.activityId,
    groupId: targetGroupId,
    added,
    operator: userId,
  });
  return activityBindingsResultCard(ctx,
    userId,
    activity,
    added
      ? `**结果**：已绑定 ${ctx.helpers.displayGroup(targetGroupId)}（发布与满员广播都会发到这个群）。`
      : `**结果**：${ctx.helpers.displayGroup(targetGroupId)} 已经绑定过了。`,
  );
}

/** `/activity unbind <#短码> <群号|#群短码>`：解绑目标群。 */
export function handleActivityUnbindCommand(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
): CardResult {
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "解绑群需要群管理员或活动发布者权限。");
  }
  const targetGroupId = resolveActivityGroupArg(ctx, parts[3]);
  if (!targetGroupId) {
    return activityDeniedCard(ctx,
      `请提供群号或 #群短码：/activity unbind ${activityCode(activity)} <群号|#群短码>`,
    );
  }
  const removed = ctx.activity!.unbindGroup(activity.activityId, targetGroupId);
  log.info("activity group binding changed", {
    activityId: activity.activityId,
    groupId: targetGroupId,
    added: false,
    removed,
    operator: userId,
  });
  return activityBindingsResultCard(ctx,
    userId,
    activity,
    removed
      ? `**结果**：已解绑 ${ctx.helpers.displayGroup(targetGroupId)}。`
      : `**结果**：${ctx.helpers.displayGroup(targetGroupId)} 本来就没有绑定。`,
  );
}

/** 绑定 / 解绑后的统一反馈：绑定群子卡 + 结果行。 */
export function activityBindingsResultCard(
  ctx: AdminCommandContext,
  userId: string,
  activity: Activity,
  notice: string,
): CardResult {
  const fresh = ctx.activity!.getActivity(activity.activityId);
  const rich = activityCardService(ctx).bindGroupsCard({
    activity: fresh,
    groups: ctx.activity!.listBoundGroups(fresh.activityId),
  });
  const code = activityCode(fresh);
  const card = renderCard({
    title: `绑定群 ${code}`,
    lines: [notice, "", ...rich.markdown.split("\n")],
    rows: [
      [
        actionButton("bind", "绑定群", `/activity bind ${code} `),
        viewButton("back", "返回配置", "activity", "config", code),
      ],
      [viewButton("manage", "返回管理", "activity", "manage", code)],
    ],
    footer: [
      `绑定：/activity bind ${code} <群号|#群短码>`,
      `解绑：/activity unbind ${code} <群号|#群短码>`,
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

/**
 * 绑定参数解析：群号 / `#群短码` / 内部群 ID 都接受。
 *
 * 解析使用与其它指令相同的 `resolveTargetGroupId`（群号与短码都走身份库），
 * 因此不会把「活动短码」误当成群号（活动短码带 `#` 时先剥离再查群）。
 */
export function resolveActivityGroupArg(ctx: AdminCommandContext, input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  return ctx.helpers.resolveTargetGroupId(undefined, trimmed);
}

/** `cb:activity:preview:<短码>`：把成员卡预览给操作者本人（不发群）。 */
export function activityPreviewCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  if (!canManageActivity(ctx, userId, found.activity)) {
    return activityDeniedCard(ctx, "预览活动卡片需要群管理员或发布者权限。");
  }
  const rich = activityCardService(ctx).memberCard(
    activityCardInput(ctx, found.activity, userId),
  );
  return { ok: true, text: rich.text, rich };
}

export async function handleActivityStats(
  ctx: AdminCommandContext,
  userId: string,
  rawCode?: string,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  // 统计图含学号/学院分布，必须再校验一次管理权限
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "统计需要群管理员或活动发布者权限。");
  }
  const stats = ctx.helpers.statsService();
  if (!stats) {
    // §B3 未装配：降级为卡片文字统计（不报错）
    return activityStatsFallback(ctx, userId, activity, replyGroupId);
  }
  try {
    const buffer = await stats.render(
      activity,
      ctx.activity!.listRegistrations(activity.activityId),
      activityProfiles(ctx, activity.activityId),
    );
    if (!buffer) {
      return activityStatsFallback(ctx, userId, activity, replyGroupId);
    }
    const sent = await stats.sendImageToGroup?.(
      activity.groupId,
      buffer,
      `activity-${activity.code}.png`,
    );
    if (!sent?.ok) {
      // 渲染成功但发送失败（未装配通道 / 上传失败）：同样降级为文字统计
      log.warn("activity stats image delivery unavailable", {
        activityId: activity.activityId,
        detail: sent?.detail ?? "未装配发送通道",
      });
      return activityStatsFallback(ctx, userId, activity, replyGroupId);
    }
    return activityNoticeCard(ctx,
      replyGroupId,
      userId,
      "**结果**：已发送统计图片。",
    );
  } catch (error) {
    log.warn("activity stats render failed", {
      activityId: activity.activityId,
      error: formatError(error),
    });
    return activityStatsFallback(ctx, userId, activity, replyGroupId);
  }
}

/** 统计/导出用的资料表：只带上确实有资料的报名者。 */
export function activityProfiles(
  ctx: AdminCommandContext,
  activityId: string,
): Map<string, UserProfile> | undefined {
  const profiles = ctx.userProfiles;
  if (!profiles) {
    return undefined;
  }
  const map = new Map<string, UserProfile>();
  for (const registration of ctx.activity!.listRegistrations(activityId)) {
    const profile = profiles.get(registration.userId);
    if (profile) {
      map.set(registration.userId, profile);
    }
  }
  return map;
}

/** 统计降级：管理卡同款文字统计。 */
export function activityStatsFallback(
  ctx: AdminCommandContext,
  userId: string,
  activity: Activity,
  replyGroupId?: string,
): CardResult {
  const rich = activityCardService(ctx).manageCard(
    activityCardInput(ctx, activity, userId),
  );
  const notice = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const lines = notice ? [notice, ...(rich.markdown.split("\n"))] : rich.markdown.split("\n");
  const card = renderCard({
    title: `活动统计 ${activityCode(activity)}`,
    lines,
    rows: [
      [
        viewButton("manage", "返回管理", "activity", "manage", activityCode(activity)),
      ],
    ],
    footer: ["统计图片不可用（服务未装配或字体缺失），以上为文字统计。"],
  });
  return { ok: true, text: card.text, rich: card };
}

export async function handleActivityExport(
  ctx: AdminCommandContext,
  userId: string,
  rawCode?: string,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "导出名单需要群管理员或活动发布者权限。");
  }
  const exporter = ctx.helpers.exportService();
  const notice = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  if (!exporter) {
    return activityNoticeCard(ctx,
      replyGroupId,
      userId,
      "**结果**：导出服务未装配，暂无法生成 CSV。可用「报名名单」查看并复制。",
    );
  }
  const result = await exporter.exportCsv({
    activity,
    registrations: ctx.activity!.listRegistrations(activity.activityId),
    waitlist: ctx.activity!.listWaitlist(activity.activityId),
    operatorId: userId,
  });
  return activityNoticeCard(ctx,
    replyGroupId,
    userId,
    `**结果**：${result.ok ? result.text : `导出失败：${result.text}`}`,
  );
}

/** 回调反馈卡：群里首行 @ 操作人，私聊直接给结果。 */
export function activityNoticeCard(
  ctx: AdminCommandContext,
  replyGroupId: string | undefined,
  userId: string,
  body: string,
): CardResult {
  const mention = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const card = renderCard({
    title: "活动操作",
    lines: [...(mention ? [mention] : []), body],
    rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
  });
  return { ok: true, text: card.text, rich: card };
}

/**
 * `cb:activity:resend:<短码>`：把成员卡重发到活动群（管理者专用）。
 *
 * 管理卡上的「重发卡片」是发布卡片的补救入口（例如原来那条被刷屏冲走）。
 */
export async function handleActivityResend(
  ctx: AdminCommandContext,
  userId: string,
  rawCode?: string,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "重发卡片需要群管理员或活动发布者权限。");
  }
  const sender = ctx.helpers.cardSender();
  if (!sender) {
    return activityNoticeCard(ctx,
      replyGroupId,
      userId,
      "**结果**：发送通道未启用，无法重发卡片。",
    );
  }
  // §B4：重发同样打到**所有绑定群**
  const card = activityMemberCard(ctx, activity, userId);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const groupId of ctx.activity!.listBoundGroups(activity.activityId)) {
    const result = await sender.sendToGroup(groupId, card);
    if (result.ok) {
      sent.push(groupId);
    } else {
      failed.push(groupId);
      log.warn("activity resend failed for group", {
        activityId: activity.activityId,
        groupId,
        error: result.detail,
      });
    }
  }
  return activityNoticeCard(ctx,
    replyGroupId,
    userId,
    `**结果**：已重发活动卡片（成功 ${sent.length} 个 / 失败 ${failed.length} 个）${
      failed.length > 0
        ? `：失败群 ${formatGroupList(failed, (id) => ctx.helpers.displayGroup(id))}`
        : "。"
    }`,
  );
}

/**
 * `cb:activity:release:<短码>`：释放一个冻结名额（手动递补模式）。
 *
 * 有候补 → 递补第一位（私信通知本人，**不往群里发**）；没有候补 → 名额放回公开池。
 */
export async function handleActivityRelease(
  ctx: AdminCommandContext,
  userId: string,
  rawCode?: string,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "释放名额需要群管理员或活动发布者权限。");
  }
  const released = ctx.activity!.releaseHeldSlot(activity.activityId);
  if (!released) {
    return activityManageNotice(ctx, userId, activity, replyGroupId, {
      ok: false,
      text: "**结果**：没有待释放的名额（可能已经被释放）。",
    });
  }
  if (released.promoted && released.registration) {
    const total = ctx.activity!.listRegistrations(activity.activityId).length;
    await notifyPromoted(ctx, activity, released.promoted, total);
    log.info("activity held slot released: promoted", {
      activityId: activity.activityId,
      promoter: userId,
      promoted: released.promoted.userId,
    });
    return activityManageNotice(ctx, userId, activity, replyGroupId, {
      ok: true,
      text: `**结果**：已释放名额并递补候补第一位（当前 ${total}${
        activity.capacity ? ` / ${activity.capacity}` : ""
      }），已私信通知本人。`,
    });
  }
  log.info("activity held slot released: opened", {
    activityId: activity.activityId,
    operator: userId,
  });
  return activityManageNotice(ctx, userId, activity, replyGroupId, {
    ok: true,
    text: "**结果**：已释放名额，当前没有候补，名额放回公开池（先到先得）。",
  });
}

/** 管理类回调的统一反馈卡：刷新后的管理卡 + 结果行。 */
export function activityManageNotice(
  ctx: AdminCommandContext,
  userId: string,
  activity: Activity,
  replyGroupId: string | undefined,
  outcome: { ok: boolean; text: string },
): CardResult {
  const fresh = ctx.activity!.getActivity(activity.activityId);
  const rich = activityCardService(ctx).manageCard(
    activityCardInput(ctx, fresh, userId),
  );
  const mention = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const lines = [
    ...(mention ? [mention] : []),
    outcome.text,
    "",
    ...rich.markdown.split("\n"),
  ];
  const card = renderCard({
    title: `活动管理 ${activityCode(fresh)}`,
    lines,
    rows: [
      [
        viewButton("signups", "报名名单", "activity", "signups", activityCode(fresh), 1),
        viewButton("resend", "重发卡片", "activity", "resend", activityCode(fresh)),
      ],
      [
        viewButton("manage", "刷新管理", "activity", "manage", activityCode(fresh)),
      ],
    ],
    buttonHint: "操作：",
    footer: [`活动配置：/activity info ${activityCode(fresh)}`],
  });
  return { ok: outcome.ok, text: card.text, rich: card };
}

/** `cb:activity:set:<短码>:<字段>:<值>`：配置卡上的快捷设置（管理者专用）。 */
export async function handleActivitySetCallback(
  ctx: AdminCommandContext,
  userId: string,
  rawCode?: string,
  field?: string,
  value?: string,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "修改活动需要群管理员或活动发布者权限。");
  }
  if (!field || value === undefined) {
    return activityDeniedCard(ctx, "回调参数不完整，请重新打开配置卡。");
  }
  const applied = applyActivitySetting(ctx,
    activity,
    field,
    value,
    ACTIVITY_NOTIFY_FIELDS.has(field),
  );
  if (!applied.ok) {
    const rich = activityCardService(ctx).configCard(
      activityCardInput(ctx, activity, userId),
    );
    const mention = ctx.helpers.mention(replyGroupId, userId).trimEnd();
    const card = renderCard({
      title: "活动未修改",
      lines: [
        ...(mention ? [mention] : []),
        `**结果**：${applied.text}`,
        "",
        ...rich.markdown.split("\n"),
      ],
      rows: [
        [viewButton("config", "返回配置", "activity", "config", activityCode(activity))],
      ],
    });
    return { ok: false, text: card.text, rich: card };
  }
  const updated = ctx.activity!.getActivity(activity.activityId);
  const rich = activityCardService(ctx).configCard(
    activityCardInput(ctx, updated, userId),
  );
  const mention = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const card = renderCard({
    title: `活动配置 ${activityCode(updated)}`,
    lines: [...(mention ? [mention] : []), applied.text, "", ...rich.markdown.split("\n")],
    rows: [
      [
        viewButton("preview", "预览", "activity", "preview", activityCode(updated)),
        viewButton("open", "开放报名", "activity", "open", activityCode(updated)),
      ],
    ],
    buttonHint: "配置项在卡片下方按钮上：",
    footer: [`活动管理：/activity set ${activityCode(updated)} <字段> <值>`],
  });
  return { ok: applied.ok, text: card.text, rich: card };
}

/**
 * `cb:activity:college|year:<短码>:<mode>:<页码>[:<取值>]`：
 * 学院 / 年级限制子卡的点选（管理者专用）。
 */
export async function handleActivityRuleToggle(
  ctx: AdminCommandContext,
  kind: "college" | "year",
  userId: string,
  rawCode?: string,
  rawMode?: string,
  page = 1,
  option?: string,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "修改限制需要群管理员或活动发布者权限。");
  }
  const mode: "allow" | "deny" = rawMode === "deny" ? "deny" : "allow";
  if (option !== undefined) {
    const applied = applyActivityRuleOption(ctx, kind, mode, activity, option);
    if (!applied.ok) {
      return activityManageNotice(ctx, userId, activity, replyGroupId, applied);
    }
    log.info("activity rule toggled", {
      activityId: activity.activityId,
      kind,
      mode,
      option,
      userId,
    });
  }
  const updated = ctx.activity!.getActivity(activity.activityId);
  const rich = activityCardService(ctx).rulesCard({
    activity: updated,
    kind,
    mode,
    page,
  });
  const label = kind === "college" ? "学院限制" : "年级限制";
  return { ok: true, text: rich.text, rich: attachNotice(ctx, rich, label) };
}

/** 规则子卡的提示：点选后回到同一张子卡（标题即位置）。 */
export function attachNotice(ctx: AdminCommandContext, rich: RichMessage, label: string): RichMessage {
  return {
    ...rich,
    markdown: `**${label}**\n${rich.markdown}`,
    text: `【${label}】\n${rich.text}`,
  };
}

/**
 * 学院 / 年级白黑名单的点选逻辑。
 *
 * `clear` 清空当前列表；否则在「当前模式」的列表里切换该取值。
 */
export function applyActivityRuleOption(
  ctx: AdminCommandContext,
  kind: "college" | "year",
  mode: "allow" | "deny",
  activity: Activity,
  option: string,
): { ok: boolean; text: string } {
  const isAllow = mode === "allow";
  const current = new Set(
    kind === "college"
      ? isAllow
        ? activity.allowColleges
        : activity.denyColleges
      : isAllow
        ? activity.allowYears
        : activity.denyYears,
  );
  const cleaned = option.trim();
  if (cleaned === "clear") {
    current.clear();
  } else if (cleaned.length === 0) {
    return { ok: false, text: "**结果**：没有识别到要切换的取值。" };
  } else if (current.has(cleaned)) {
    current.delete(cleaned);
  } else {
    current.add(cleaned);
  }
  const next = [...current].sort();
  try {
    if (kind === "college") {
      ctx.activity!.updateActivity(
        activity.activityId,
        isAllow ? { allowColleges: next } : { denyColleges: next },
      );
    } else {
      ctx.activity!.updateActivity(
        activity.activityId,
        isAllow ? { allowYears: next } : { denyYears: next },
      );
    }
  } catch (error) {
    return { ok: false, text: `**结果**：${formatError(error)}` };
  }
  const label = kind === "college" ? "学院" : "年级";
  return {
    ok: true,
    text:
      cleaned === "clear"
        ? `**结果**：已清空${isAllow ? "允许" : "禁止"}${label}（表示不限）。`
        : `**结果**：已更新${isAllow ? "允许" : "禁止"}${label}：${next.join("、") || "（空）"}`,
  };
}

export function requireActivity(
  ctx: AdminCommandContext,
  code: string | undefined,
): { ok: true; activity: Activity } | { ok: false; text: string } {
  if (!code) {
    return { ok: false, text: ACTIVITY_USAGE };
  }
  try {
    return { ok: true, activity: ctx.activity!.requireByCode(code) };
  } catch (error) {
    return { ok: false, text: `活动不存在：${code}` };
  }
}

export function canManageActivity(ctx: AdminCommandContext, userId: string, activity: Activity): boolean {
  return (
    ctx.permissions.isSuperAdmin(userId) ||
    activity.createdBy === userId ||
    ctx.permissions.canApproveJoin(userId, activity.groupId)
  );
}

/**
 * 活动字段应用（`/activity set` 与配置卡回调共用一条路径）。
 *
 * - 布尔开关接受 `on/off/true/false/开/关`；
 * - `clear` 清空（链接、限制、名额、截止、简介）；
 * - `closeAt` 接受 `MM-DD HH:mm`（默认当年）或 `YYYY-MM-DD HH:mm`；
 * - `notify` 为真时，改到「当事人关心的字段」会给已报名 + 候补私信一次变更通知。
 */
export function applyActivitySetting(
  ctx: AdminCommandContext,
  activity: Activity,
  field: string,
  value: string,
  notify: boolean,
): { ok: boolean; text: string } {
  const activities = ctx.activity!;
  const cleared = CLEAR_WORDS.has(value.trim().toLowerCase());
  try {
    switch (field) {
      case "title":
      case "标题":
        if (cleared) {
          return { ok: false, text: "标题不能清空，请填写新的标题。" };
        }
        activities.updateActivity(activity.activityId, { title: value });
        break;
      case "desc":
      case "description":
      case "描述":
        activities.updateActivity(activity.activityId, {
          description: cleared ? "" : value,
        });
        break;
      case "capacity":
      case "名额":
        activities.updateActivity(activity.activityId, {
          capacity: cleared ? undefined : parsePositiveInt(field, value),
        });
        break;
      case "group":
      case "群号":
        activities.updateActivity(activity.activityId, {
          groupNumber: cleared ? "" : value,
        });
        break;
      case "link":
      case "链接":
        activities.updateActivity(activity.activityId, {
          links: cleared ? [] : [...activity.links, parseLink(value)],
        });
        break;
      case "links":
      case "链接列表":
        activities.updateActivity(activity.activityId, {
          links: cleared ? [] : parseLinks(value),
        });
        break;
      case "closeat":
      case "截止":
        activities.updateActivity(activity.activityId, {
          closeAt: cleared ? undefined : parseCloseAt(value),
        });
        break;
      case "waitlistpromotion":
      case "递补":
        return setWaitlistPromotion(ctx, activity, value, cleared);
      case "mentionall":
      case "提醒全体":
        activities.updateActivity(activity.activityId, {
          mentionAll: parseToggle(field, value),
        });
        break;
      case "notifycreator":
      case "通知发起人":
        activities.updateActivity(activity.activityId, {
          notifyCreator: parseToggle(field, value),
        });
        break;
      case "allowcolleges":
      case "允许学院":
        activities.updateActivity(activity.activityId, {
          allowColleges: cleared ? [] : parseList(value),
        });
        break;
      case "denycolleges":
      case "禁止学院":
      case "不允许学院":
        activities.updateActivity(activity.activityId, {
          denyColleges: cleared ? [] : parseList(value),
        });
        break;
      case "allowyears":
      case "允许年级":
        activities.updateActivity(activity.activityId, {
          allowYears: cleared ? [] : parseYearList(value),
        });
        break;
      case "denyyears":
      case "禁止年级":
      case "不允许年级":
        activities.updateActivity(activity.activityId, {
          denyYears: cleared ? [] : parseYearList(value),
        });
        break;
      default:
        return { ok: false, text: ACTIVITY_SET_USAGE };
    }
  } catch (error) {
    return { ok: false, text: `设置失败：${formatError(error)}` };
  }
  const updated = activities.getActivity(activity.activityId);
  if (notify) {
    voidNotifyActivityChanged(ctx, updated, field);
  }
  return { ok: true, text: `**结果**：已更新 ${field}（${activityCode(updated)}）。` };
}

/** 递补方式：`auto`（自动递补）会先把已有冻结名额释放掉。 */
export function setWaitlistPromotion(
  ctx: AdminCommandContext,
  activity: Activity,
  value: string,
  cleared: boolean,
): { ok: boolean; text: string } {
  const activities = ctx.activity!;
  const normalized = normalize(value);
  const mode: "auto" | "manual" = cleared
    ? "manual"
    : normalized === "auto" || normalized === "自动" || normalized === "自动递补"
      ? "auto"
      : normalized === "manual" || normalized === "手动" || normalized === "手动释放"
        ? "manual"
        : TOGGLE_ON.has(normalized)
          ? "auto"
          : TOGGLE_OFF.has(normalized)
            ? "manual"
            : (() => {
                throw new Error("递补方式需要 auto（自动）或 manual（手动）");
              })();
  if (mode === "auto" && activity.heldSlots > 0) {
    activities.releaseHeldSlot(activity.activityId);
  }
  activities.updateActivity(activity.activityId, { waitlistPromotion: mode });
  return {
    ok: true,
    text: `**结果**：递补方式已改为「${mode === "auto" ? "自动递补" : "手动释放名额"}」。`,
  };
}

/**
 * 活动变更通知（`kind: "changed"`）：私信已报名 + 候补者，**不往群里发**。
 *
 * 去重 + 每日封顶在 `ActivityNotificationService` 里统一做；没有通知服务时静默跳过。
 */
export function voidNotifyActivityChanged(ctx: AdminCommandContext, activity: Activity, field: string): void {
  const notifications = ctx.activityNotifications;
  if (!notifications) {
    return;
  }
  const userIds = participantIds(ctx, activity);
  if (userIds.length === 0) {
    return;
  }
  const text = [
    `活动 **${escapeCardText(activity.title)}**（${activityCode(activity)}）有变更：`,
    `- 变更字段：${escapeCardText(field)}`,
    `- 报名：${ctx.activity!.listRegistrations(activity.activityId).length}${
      activity.capacity === undefined ? "" : ` / ${activity.capacity}`
    }`,
    `- 截止：${formatCloseAt(activity)}`,
    "",
    `查看详情：/activity info ${activityCode(activity)}`,
  ].join("\n");
  void notifications
    .notifyParticipants({
      activityId: activity.activityId,
      userIds,
      kind: "changed",
      text,
    })
    .catch((error: unknown) => {
      log.warn("activity change notify failed", {
        activityId: activity.activityId,
        error: formatError(error),
      });
    });
}

/** 发布（open）：群内发成员卡 + 私信回执 + 给订阅者私信活动卡。 */
export async function publishActivity(
  ctx: AdminCommandContext,
  userId: string,
  rawCode: string | undefined,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "发布活动需要群管理员或活动发布者权限。");
  }
  const opened = ctx.activity!.openActivity(activity.activityId);
  // §B4：发布到**所有绑定群**（不是只有归属群），并逐个记录成功 / 失败
  const groups = ctx.activity!.listBoundGroups(opened.activityId);
  const sender = ctx.helpers.cardSender();
  const memberCard = activityMemberCard(ctx, opened, userId);
  const sentGroups: string[] = [];
  const failedGroups: string[] = [];
  if (sender) {
    for (const groupId of groups) {
      const result = await sender.sendToGroup(groupId, memberCard);
      if (result.ok) {
        sentGroups.push(groupId);
      } else {
        failedGroups.push(groupId);
        log.warn("activity publish failed for group", {
          activityId: opened.activityId,
          groupId,
          error: result.detail,
        });
      }
    }
  } else {
    failedGroups.push(...groups);
  }
  const published = groups.length > 0 && failedGroups.length === 0;
  const groupReceipt = activityNoticeCard(ctx,
    replyGroupId,
    userId,
    published
      ? `**结果**：活动已开放报名，活动卡片已发送到 ${sentGroups.length} 个绑定群。`
      : `**结果**：活动已开放报名，卡片发送结果：成功 ${sentGroups.length} 个 / 失败 ${failedGroups.length} 个。`,
  );
  // 操作者私信回执：列出各群发送结果 + 「@全体不可用」提示 + 重发 / 关停入口
  const receiptSender = ctx.helpers.cardSender();
  if (receiptSender) {
    const hint = opened.mentionAll
      ? "你开启了「提醒@全体」：**机器人无法 @全体成员**，如需通知全群请手动 @ 一条。"
      : "机器人无法 @全体成员；如需通知全群请手动 @ 一条。";
    const receipt = renderCard({
      title: `活动已发布 ${activityCode(opened)}`,
      lines: [
        `**活动**：${escapeCardText(opened.title)}`,
        `**绑定群**：${groups.length} 个`,
        `**成功**：${formatGroupList(sentGroups, (id) => ctx.helpers.displayGroup(id)) || "（无）"}`,
        `**失败**：${formatGroupList(failedGroups, (id) => ctx.helpers.displayGroup(id)) || "（无）"}`,
        "",
        hint,
        "",
        `查看详情：/activity info ${activityCode(opened)}`,
      ],
      rows: [
        [
          viewButton("resend", "重发卡片", "activity", "resend", activityCode(opened)),
          viewButton("close", "关闭报名", "activity", "status", activityCode(opened), "close"),
        ],
      ],
    });
    await receiptSender
      .sendToUser(userId, receipt)
      .catch(() => undefined);
  }
  log.info("activity published", {
    activityId: opened.activityId,
    groupId: opened.groupId,
    by: userId,
    published,
  });
  await pushNewActivity(ctx, opened);
  return groupReceipt;
}

/** 给**所有绑定群**的订阅者私信新活动卡片（只发给订阅者，不群发）。 */
export async function pushNewActivity(ctx: AdminCommandContext, activity: Activity): Promise<void> {
  const notifications = ctx.activityNotifications;
  if (!notifications) {
    return;
  }
  const card = activityMemberCard(ctx, activity, activity.createdBy);
  for (const groupId of ctx.activity!.listBoundGroups(activity.activityId)) {
    try {
      await notifications.publishNewActivity({
        activityId: activity.activityId,
        groupId,
        card,
      });
    } catch (error) {
      log.warn("activity publish push failed", {
        activityId: activity.activityId,
        groupId,
        error: formatError(error),
      });
    }
  }
}

/**
 * 满员广播（§B4）：本次报名后**恰好满员**时，往所有绑定群发一次「已满」卡。
 *
 * 每个群只发一次（`activity_notifications` 的 `(活动, "group:<群ID>", "full")` 去重），
 * 未装配群发送通道时静默跳过（不报错）。
 */
export async function announceActivityFull(ctx: AdminCommandContext, activityId: string): Promise<void> {
  const notifications = ctx.activityNotifications;
  if (!notifications) {
    return;
  }
  const activity = ctx.activity!.getActivity(activityId);
  const capacity = activity.capacity;
  if (capacity === undefined) {
    return;
  }
  const registered = ctx.activity!.listRegistrations(activityId).length;
  if (registered + activity.heldSlots < capacity) {
    return;
  }
  const groups = ctx.activity!.listBoundGroups(activityId);
  if (groups.length === 0) {
    return;
  }
  try {
    const result = await notifications.notifyGroupsCard({
      activityId,
      groupIds: groups,
      kind: "full",
      card: activityCardService(ctx).fullCard(
        activityCardInput(ctx, activity, activity.createdBy),
      ),
    });
    log.info("activity full broadcast finished", {
      activityId,
      groups: groups.length,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      available: result.available,
    });
  } catch (error) {
    log.warn("activity full broadcast failed", {
      activityId,
      error: formatError(error),
    });
  }
}

/** 递补成功：私信被递补者「你已递补成功（当前 Y/Z）」，**不往群里发**。 */
export async function notifyPromoted(
  ctx: AdminCommandContext,
  activity: Activity,
  entry: ActivityWaitlistEntry,
  total: number,
): Promise<void> {
  const notifications = ctx.activityNotifications;
  if (!notifications) {
    return;
  }
  const text = [
    `你已递补成功（活动 ${escapeCardText(activity.title)}，当前 ${total}${
      activity.capacity === undefined ? "" : ` / ${activity.capacity}`
    }）。`,
    `活动群：${activity.groupNumber || ctx.helpers.displayGroup(activity.groupId)}`,
    "",
    `取消报名：/activity quit ${activityCode(activity)}`,
  ].join("\n");
  await notifications
    .notifyParticipants({
      activityId: activity.activityId,
      userIds: [entry.userId],
      kind: "promoted",
      text,
      title: "候补递补成功",
    })
    .catch((error: unknown) => {
      log.warn("activity promotion notify failed", {
        activityId: activity.activityId,
        error: formatError(error),
      });
    });
}

/** 取消活动：私信所有已报名 + 候补者。 */
export async function notifyActivityCancelled(ctx: AdminCommandContext, activity: Activity): Promise<void> {
  const notifications = ctx.activityNotifications;
  const userIds = participantIds(ctx, activity);
  if (!notifications || userIds.length === 0) {
    return;
  }
  const text = [
    `活动 **${escapeCardText(activity.title)}**（${activityCode(activity)}）已取消。`,
    `活动群：${activity.groupNumber || ctx.helpers.displayGroup(activity.groupId)}`,
    "",
    "如有疑问请联系活动管理者。",
  ].join("\n");
  await notifications
    .notifyParticipants({
      activityId: activity.activityId,
      userIds,
      kind: "cancelled",
      text,
      title: "活动已取消",
    })
    .catch((error: unknown) => {
      log.warn("activity cancel notify failed", {
        activityId: activity.activityId,
        error: formatError(error),
      });
    });
}

/** 活动的当事人（已报名 + 候补，去重）。 */
export function participantIds(ctx: AdminCommandContext, activity: Activity): string[] {
  const registrations = ctx.activity!.listRegistrations(activity.activityId);
  const waitlist = ctx.activity!.listWaitlist(activity.activityId);
  return [
    ...new Set([
      ...registrations.map((item) => item.userId),
      ...waitlist.map((item) => item.userId),
    ]),
  ];
}

/**
 * 报名（`/activity join` 与 `cb:activity:join` 共用）。
 *
 * 消息落点（§B4 用户确认，**优先于 §B2 的 1.6**）：
 * - **群里操作**（回调或手输）：群内**一律静默**（连「原因已私信」都不发），
 *   成功 / 候补 / 失败原因全部**私信**给本人；
 * - **私聊操作**：原地回复，可含姓名 / 学号 / 班级 / 人数；
 * - **唯一例外**：私信发送失败时，允许群里回一条**不含任何结果**的提示
 *   （`<@!申请人> 私信发送失败，请先私聊机器人再试`），否则用户会以为没反应。
 *
 * `dmOnly` / `dmSilent` 由调用方给出（见 `ActivityDmOptions`）：
 * 群内回调 / 群内手输都是 `dmOnly: true`，前者 `dmSilent: false`（renderer 返回 undefined），
 * 后者 `dmSilent: true`（命令返回 `silent: true` 让 gatewayRunner 跳过群回复）；
 * 私聊（命令或回调）是 `dmOnly: false`，原地回复。
 */
export async function joinActivityCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
  dmOptions: ActivityDmOptions,
): Promise<CardResult | undefined> {
  const dmOnly = dmOptions.dmOnly;
  const silent = dmOptions.dmSilent;
  // 回执可以带完整信息（姓名 / 学号 / 班级）：群内私信回执与私聊原地回复都是本人可见
  const showFullReceipt = true;
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return dmOnly
      ? dmOnlyFailure(ctx, silent, userId, `活动不存在：${parts[2] ?? "（空短码）"}`)
      : activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const { activity } = found;
  const profiles = ctx.userProfiles;
  if (!profiles) {
    const reason = "个人资料服务未启用，无法校验报名资格。";
    if (dmOnly) {
      return dmOnlyFailure(ctx, silent, userId, reason);
    }
    const card = renderCard({ title: "报名未通过", lines: [reason] });
    return { ok: false, text: card.text, rich: card };
  }
  let profile;
  try {
    profile = profiles.requireComplete(userId);
    ctx.activity!.checkEligibility(activity, profile);
  } catch (error) {
    if (error instanceof UserProfileError || error instanceof ActivityRuleError) {
      return activityJoinFailure(ctx, groupId, userId, activity, error.message, dmOptions);
    }
    throw error;
  }
  let outcome;
  try {
    outcome = ctx.activity!.joinActivity({
      activityId: activity.activityId,
      userId,
      displayName: profile.name,
      note: parts.slice(3).join(" ").trim(),
    });
  } catch (error) {
    if (error instanceof ActivityRuleError) {
      return activityJoinFailure(ctx, groupId, userId, activity, error.message, dmOptions);
    }
    return activityJoinFailure(ctx,
      groupId,
      userId,
      activity,
      formatError(error),
      dmOptions,
    );
  }
  const total = ctx.activity!.listRegistrations(activity.activityId).length;
  const capacity = activity.capacity;
  const ticket = capacity === undefined ? `${total}` : `${total} / ${capacity}`;
  if (outcome.status === "waitlisted") {
    const card = joinReceiptCard(ctx, {
      title: "候补登记",
      body: `已进入候补 · 第 ${outcome.position} 位`,
      activity,
      ticket,
      ...(showFullReceipt ? { profile } : {}),
    });
    if (dmOnly) {
      const delivered = await deliverSilentReceipt(ctx, card, userId, groupId);
      return delivered
        ? silentReceiptResult(ctx, card, silent)
        : silentFallbackCard(ctx, groupId ?? "", userId);
    }
    return { ok: true, text: card.text, rich: card };
  }
  // 报名恰好满员 → 在所有绑定群广播一次「已满」卡（每个群只发一次）
  if (outcome.becameFull) {
    await announceActivityFull(ctx, activity.activityId);
  }
  const card = joinReceiptCard(ctx, {
    title: "报名成功",
    body: `报名成功 · 当前 ${ticket}`,
    activity,
    ticket,
    ...(showFullReceipt ? { profile } : {}),
  });
  if (dmOnly) {
    const delivered = await deliverSilentReceipt(ctx, card, userId, groupId);
    return delivered
      ? silentReceiptResult(ctx, card, silent)
      : silentFallbackCard(ctx, groupId ?? "", userId);
  }
  return { ok: true, text: card.text, rich: card };
}

/**
 * 报名结果卡。
 *
 * - 群内静默路径（`profile` 存在）：私信卡可以含姓名 / 学号 / 班级 / 人数；
 * - 私聊原地回复 / 兜底路径：正文只写结果（不含隐私字段）。
 */
export function joinReceiptCard(
  ctx: AdminCommandContext,
  input: {
    title: string;
  body: string;
  activity: Activity;
  ticket: string;
  profile?: UserProfile | undefined;
}): RichMessage {
  const footer = [`取消报名：/activity quit ${activityCode(input.activity)}`];
  const profile = input.profile;
  if (!profile) {
    return renderCard({
      title: input.title,
      lines: [`**结果**：${escapeCardText(input.body)}`],
      footer,
    });
  }
  return renderCard({
    title: input.title,
    lines: [
      `**结果**：${escapeCardText(input.body)}`,
      `**姓名**：${escapeCardText(profile.name)}`,
      `**学号**：${escapeCardText(profile.studentId)}`,
      `**班级**：${escapeCardText(profile.className)}`,
      `**当前报名**：${input.ticket}`,
      "",
      ...footer,
    ],
  });
}

/**
 * 群内静默路径的私信投递（§B4）：**结果只私信给本人**。
 *
 * 返回 `true` = 私信已送达；`false` = 私信失败或没有私信通道
 * （调用方用 `silentFallbackCard` 给群内**不含结果**的兜底提示）。
 *
 * 私聊点击的回调（`dmGroupId` 为空）本来就不该走静默路径，调用方会原地回复。
 */
export async function deliverSilentReceipt(
  ctx: AdminCommandContext,
  card: RichMessage,
  userId: string,
  dmGroupId: string | undefined,
): Promise<boolean> {
  const sender = ctx.helpers.cardSender();
  if (!sender || !dmGroupId) {
    return false;
  }
  const sent = await sender.sendToUser(userId, card);
  if (sent.ok) {
    log.info("activity receipt DM delivered", { userId });
    return true;
  }
  log.warn("activity group receipt DM failed", { userId, error: sent.detail });
  return false;
}

/**
 * 群内静默路径的返回值：命令路径发 `silent: true`，回调路径发 `undefined`。
 *
 * `ok` 保留业务结果（报名失败仍是 `false`，只是不在群里公开）；命令路径的
 * `text` / `rich` 只是「不落地到群聊」的容器，`silent: true` 会拦下发送。
 */
export function silentReceiptResult(
  ctx: AdminCommandContext,
  card: RichMessage,
  commandPath: boolean,
  ok = true,
): CardResult | undefined {
  if (!commandPath) {
    return undefined;
  }
  return { ok, text: card.text, rich: card, silent: true };
}

/**
 * 群内唯一的静默例外卡片：`<@!申请人>` + 「私信发送失败，请先私聊机器人再试」。
 *
 * 正文**不含任何结果字段**（成功 / 候补 / 失败原因都不出现）。
 */
export function silentFallbackCard(ctx: AdminCommandContext, replyGroupId: string, userId: string): CardResult {
  const card = renderCard({
    title: "活动",
    lines: [`<@!${userId}>`, "私信发送失败，请先私聊机器人再试"],
  });
  return { ok: false, text: card.text, rich: card };
}

/** 静默路径下活动不存在 / 资料服务缺失：只私信，群里不发。 */
export async function dmOnlyFailure(
  ctx: AdminCommandContext,
  silent: boolean,
  userId: string,
  reason: string,
): Promise<CardResult> {
  const card = renderCard({
    title: "活动操作",
    lines: [`**结果**：${escapeCardText(reason)}`],
  });
  const sender = ctx.helpers.cardSender();
  if (sender) {
    await sender.sendToUser(userId, card).catch(() => undefined);
  }
  return {
    ok: false,
    text: card.text,
    rich: card,
    ...(silent ? { silent: true } : {}),
  };
}

/**
 * 报名失败：群里不再回执（§B4 群内静默），原因只私信。
 *
 * 私信失败时群里只提示「请先私聊机器人再试」，**绝不**把原因降级到群里
 * （原因可能包含班级/学院等个人资料）。
 */
export async function activityJoinFailure(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  activity: Activity,
  reason: string,
  dmOptions?: ActivityDmOptions,
): Promise<CardResult | undefined> {
  const privateCard = renderCard({
    title: "报名未通过",
    lines: [
      `**活动**：${escapeCardText(activity.title)}（${activityCode(activity)}）`,
      `**原因**：${escapeCardText(reason)}`,
      "",
      `查看详情：/activity info ${activityCode(activity)}`,
    ],
  });
  // §B4：群内静默 —— 结果（含失败原因）只私信，群里一条都不发
  if (dmOptions?.dmOnly) {
    if (!groupId) {
      return { ok: false, text: privateCard.text, rich: privateCard };
    }
    const delivered = await deliverSilentReceipt(ctx, privateCard, userId, groupId);
    if (!delivered) {
      return silentFallbackCard(ctx, groupId, userId);
    }
    // 命令路径（`dmSilent`）给 `silent: true` 的卡片；回调路径给 undefined（不发言）
    return silentReceiptResult(ctx, privateCard, dmOptions.dmSilent, false);
  }
  const sender = ctx.helpers.cardSender();
  const sent = sender
    ? await sender.sendToUser(userId, privateCard)
    : { ok: false, detail: "私信通道未启用" };
  if (groupId) {
    const card = renderCard({
      title: "报名未通过",
      lines: [
        `<@!${userId}>`,
        sent.ok
          ? escapeCardText("报名未通过，原因已私信。")
          : escapeCardText("报名未通过，请先私聊机器人再试（原因只走私信）。"),
      ],
      footer: [`活动详情：/activity info ${activityCode(activity)}`],
    });
    return { ok: false, text: card.text, rich: card };
  }
  return { ok: false, text: privateCard.text, rich: privateCard };
}

/**
 * 取消报名（`/activity quit` 与 `cb:activity:quit` 共用）。
 *
 * - `auto` 模式：立刻递补候补第一位，并私信被递补者；
 * - `manual` 模式（默认）：名额被冻结（待释放名额 +1）；
 * - §B4：群里操作时**群内静默**，回执只私信本人（连「谁退出了」都不会出现在群里）。
 */
export async function quitActivityCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
  dmOptions?: ActivityDmOptions,
): Promise<CardResult | undefined> {
  const dmOnly = dmOptions?.dmOnly ?? false;
  const silent = dmOptions?.dmSilent ?? false;
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return dmOnly
      ? dmOnlyFailure(ctx, silent, userId, `活动不存在：${parts[2] ?? "（空短码）"}`)
      : activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const returnCard = async (card: RichMessage): Promise<CardResult | undefined> => {
    if (dmOnly) {
      const delivered = await deliverSilentReceipt(ctx, card, userId, groupId);
      if (delivered) {
        return silentReceiptResult(ctx, card, silent);
      }
      return silentFallbackCard(ctx, groupId ?? "", userId);
    }
    return { ok: true, text: card.text, rich: card };
  };
  const { activity } = found;
  const registration = ctx.activity!.findRegistration(
    activity.activityId,
    userId,
  );
  if (!registration) {
    const card = renderCard({
      title: "取消报名",
      lines: ["**结果**：你还没有报名这个活动。"],
    });
    return returnCard(card);
  }
  const outcome = ctx.activity!.cancelRegistrationWithPromotion(
    registration.registrationId,
    userId,
  );
  const lines: string[] = ["**结果**：已取消报名。"];
  if (outcome.promoted && outcome.registration) {
    const total = ctx.activity!.listRegistrations(activity.activityId).length;
    await notifyPromoted(ctx,
      ctx.activity!.getActivity(activity.activityId),
      outcome.promoted,
      total,
    );
    lines.push("**结果**：已自动递补候补第一位（已私信通知本人）。");
  } else if (outcome.heldSlots > 0) {
    lines.push(
      `**结果**：名额已冻结，等待管理员释放（待释放名额 ${outcome.heldSlots}）。`,
    );
  }
  const fresh = ctx.activity!.getActivity(activity.activityId);
  lines.push(`**当前报名**：${ctx.activity!.listRegistrations(fresh.activityId).length}${
    fresh.capacity === undefined ? "" : ` / ${fresh.capacity}`
  }`);
  // 只有「私聊原地回复」才需要 mention；静默路径由 deliverSilentReceipt 处理落点
  const mention = dmOnly ? "" : ctx.helpers.mention(groupId, userId).trimEnd();
  const card = renderCard({
    title: "取消报名",
    lines: [...(mention ? [mention] : []), ...lines],
    footer: [
      `重新报名：/activity join ${activityCode(fresh)}`,
      ...(fresh.heldSlots > 0 && canManageActivity(ctx, userId, fresh)
        ? ["释放名额：管理卡上的「释放名额」按钮"]
        : []),
    ],
  });
  return returnCard(card);
}

/** 名单卡：管理者专用（非管理者回调也只得到「权限不足」卡）。 */
export function handleActivitySignups(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
  replyGroupId?: string,
  override: { page?: number; full?: boolean } = {},
): CardResult {
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "只有群管理员或活动发布者可以查看报名名单。");
  }
  const rawPage = override.page ?? parseSignupPage(parts);
  const full = override.full ?? parts.includes("full");
  const rich = activityCardService(ctx).signupsCard({
    ...activityCardInput(ctx, activity, userId),
    page: rawPage,
    full,
  });
  const mention = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  if (!mention) {
    return { ok: true, text: rich.text, rich };
  }
  return {
    ok: true,
    text: rich.text,
    rich: { ...rich, markdown: `${mention}\n${rich.markdown}` },
  };
}

export function handleActivityCreate(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): CommandResult {
  let targetGroupId = groupId;
  let titleParts = parts.slice(2);
  if (!targetGroupId) {
    const fromInput = ctx.helpers.resolveTargetGroupId(undefined, parts[2]);
    if (fromInput && parts.length > 3) {
      targetGroupId = fromInput;
      titleParts = parts.slice(3);
    }
  }
  if (!targetGroupId) {
    return {
      ok: false,
      text: "用法：群内 /activity create <标题>；私信 /activity create <群号|#群短码> <标题>",
    };
  }
  if (!ctx.permissions.canApproveJoin(userId, targetGroupId)) {
    return { ok: false, text: "权限不足：发布活动需要群管理员或以上权限。" };
  }
  const title = titleParts.join(" ").trim();
  if (title.length === 0) {
    return { ok: false, text: "请提供活动标题：/activity create <标题>" };
  }
  try {
    const activity = ctx.activity!.createActivity({
      groupId: targetGroupId,
      title,
      createdBy: userId,
      groupNumber: ctx.identityMap?.getGroupNumber(targetGroupId) ?? "",
    });
    // 用户确认：`/activity create` 之后直接返回**配置卡**（短码 + 全部配置按钮）
    const rich = activityCardService(ctx).configCard(
      activityCardInput(ctx, activity, userId),
    );
    return { ok: true, text: rich.text, rich };
  } catch (error) {
    return { ok: false, text: `创建失败：${formatError(error)}` };
  }
}

export function handleActivitySet(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
  replyGroupId?: string,
): CommandResult {
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "只有群管理员或活动发布者可以修改活动。");
  }
  const field = normalize(parts[3]);
  const value = parts.slice(4).join(" ").trim();
  if (!field || value.length === 0) {
    return { ok: false, text: ACTIVITY_SET_USAGE };
  }
  const applied = applyActivitySetting(ctx,
    activity,
    field,
    value,
    ACTIVITY_NOTIFY_FIELDS.has(field),
  );
  if (!applied.ok) {
    return { ok: false, text: applied.text };
  }
  const updated = ctx.activity!.getActivity(activity.activityId);
  const rich = activityCardService(ctx).configCard(
    activityCardInput(ctx, updated, userId),
  );
  return { ok: true, text: rich.text, rich };
}

export async function handleActivityOpen(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
  replyGroupId?: string,
): Promise<CardResult>
{
  return publishActivity(ctx, userId, parts[2], replyGroupId);
}

export async function handleActivityStatus(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
  mode: "close" | "cancel" | "open",
  replyGroupId?: string,
): Promise<CardResult>
{
  if (mode === "open") {
    return publishActivity(ctx, userId, parts[2], replyGroupId);
  }
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "只有群管理员或活动发布者可以操作活动。");
  }
  const updated =
    mode === "close"
      ? ctx.activity!.closeActivity(activity.activityId)
      : ctx.activity!.cancelActivity(activity.activityId);
  if (mode === "cancel") {
    await notifyActivityCancelled(ctx, updated);
    const notified =
      ctx.activity!.listRegistrations(updated.activityId).length +
      ctx.activity!.listWaitlist(updated.activityId).length;
    return activityNoticeCard(ctx,
      replyGroupId,
      userId,
      `**结果**：已取消活动 ${activityCode(updated)}，已私信通知 ${notified} 位同学。`,
    );
  }
  return activityManageNotice(ctx, userId, updated, replyGroupId, {
    ok: true,
    text: "**结果**：已关闭报名（不再接受新的报名）。",
  });
}

/**
 * 命令路径的报名 / 取消报名。
 *
 * §B4：群内手输 `/activity join|quit` 时**群内静默** —— 结果私信给本人，命令返回值
 * 带 `silent: true` 让 `gatewayRunner` 跳过群回复；私聊里照常原地回复。
 */
export async function handleActivityJoin(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CardResult> {
  const result = await joinActivityCard(ctx, groupId, userId, parts, {
    dmOnly: groupId !== undefined,
    dmSilent: groupId !== undefined,
  });
  return result ?? activityUnavailableCard(ctx);
}

export async function handleActivityQuit(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CardResult> {
  const result = await quitActivityCard(ctx, groupId, userId, parts, {
    dmOnly: groupId !== undefined,
    dmSilent: groupId !== undefined,
  });
  return result ?? activityUnavailableCard(ctx);
}

/**
 * 理论上不可达的兜底卡（命令路径必须给出卡片）。
 *
 * 静默路径在命令上下文中总是返回带 `silent: true` 的卡片，因此这里只在
 * 调用方误用（例如把回调路径的结果当成指令结果返回）时出现。
 */
export function activityUnavailableCard(ctx: AdminCommandContext): CardResult {
  const card = renderCard({
    title: "活动",
    lines: ["操作已完成，但结果无法投递，请私聊机器人后重试。"],
  });
  return { ok: false, text: card.text, rich: card, silent: true };
}

/** `/activity info <#短码>`：详情卡（回调 `cb:activity:info` 复用）。 */
export function handleActivityInfo(
  ctx: AdminCommandContext,
  userId: string,
  code: string | undefined,
): CardResult {
  return activityInfoCard(ctx, userId, code);
}

export function formatActivityList(ctx: AdminCommandContext, groupId: string): string {
  const activities = ctx.activity!.listActivities(groupId);
  if (activities.length === 0) {
    return `群 ${ctx.helpers.displayGroup(groupId)} 还没有活动。\n\n${ACTIVITY_USAGE}`;
  }
  const lines = [`群 ${ctx.helpers.displayGroup(groupId)} 的活动：`];
  for (const activity of activities) {
    const count = ctx.activity!.listRegistrations(activity.activityId).length;
    lines.push(
      `- ${activityCode(activity)} ${activity.title} [${activity.status}] 报名 ${count}${
        activity.capacity ? `/${activity.capacity}` : ""
      }`,
    );
  }
  lines.push("", `查看详情：/activity info <活动短码>`);
  return lines.join("\n");
}

export function formatActivityInfo(ctx: AdminCommandContext, activity: Activity): string
{
  const rich = activityCardService(ctx).configCard(
    activityCardInput(ctx, activity, activity.createdBy),
  );
  return rich.text;
}
