import { getLogger } from "../../core/logger.js";
import type { Activity } from "../activity.js";
import {
  code as activityCode,
  formatCloseAt,
} from "../activityCards.js";
import type { ActivityNotificationService } from "../activityNotifications.js";
import { extractPageToken } from "../callbackData.js";
import {
  escapeCardText,
  renderCard,
} from "../cardTemplate.js";
import type { RichMessage } from "../richMessages.js";
import {
  activityListCard,
  activityManageCard,
  activityConfigCard,
  isSubscribedTo,
  activityDeniedCard,
  activityInfoCard,
  activityPreviewCard,
  activityCardService,
  activityNotFoundCard,
  requireActivity,
  canManageActivity,
  activityBindingsResultCard,
  resolveActivityGroupArg,
  activityStatsFallback,
  activityNoticeCard,
  activityMemberCard,
  activityManageNotice,
  activityCardInput,
  activityUnavailableCard,
} from "./activityCardCommands.js";
import {
  announceActivityFull,
  joinActivityCard,
  quitActivityCard,
  activityProfiles,
  notifyPromoted,
  participantIds,
  publishActivity,
  notifyActivityCancelled,
} from "./activityFlowCommands.js";
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

/**
 * 活动回调与指令层：/activity 各子指令、cb:activity:* 回调分发、活动设置与规则点选。
 */

const log = getLogger("admin-commands");

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
  });
}

/** 管理卡入口（管理者专用）。 */

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
  const applied = await applyActivitySetting(ctx,
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

/**
 * 活动字段应用（`/activity set` 与配置卡回调共用一条路径）。
 *
 * - 布尔开关接受 `on/off/true/false/开/关`；
 * - `clear` 清空（链接、限制、名额、截止、简介）；
 * - `closeAt` 接受 `MM-DD HH:mm`（默认当年）或 `YYYY-MM-DD HH:mm`；
 * - `notify` 为真时，改到「当事人关心的字段」会给已报名 + 候补私信一次变更通知。
 */
export async function applyActivitySetting(
  ctx: AdminCommandContext,
  activity: Activity,
  field: string,
  value: string,
  notify: boolean,
): Promise<{ ok: boolean; text: string }> {
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
        // 名额被调小到「已满」时也广播一次「活动已满」卡；
        // announceActivityFull 自己会判断是否真的满员，且 `(活动, 群, full)` 去重表保证每个群只发一次。
        await announceActivityFull(ctx, activity.activityId);
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
      case "remindat":
      case "提醒":
      case "提醒时间":
        activities.updateActivity(activity.activityId, {
          remindAt: cleared ? undefined : parseCloseAt(value, "提醒时间"),
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

export async function handleActivitySet(
  ctx: AdminCommandContext,
  userId: string,
  parts: readonly string[],
  replyGroupId?: string,
): Promise<CommandResult> {
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
  const applied = await applyActivitySetting(ctx,
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

export function handleActivityInfo(
  ctx: AdminCommandContext,
  userId: string,
  code: string | undefined,
): CardResult {
  return activityInfoCard(ctx, userId, code);
}
