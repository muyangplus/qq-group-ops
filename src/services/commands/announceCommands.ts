import { PermissionLevel } from "../../core/enums.js";
import { buildKeyboard, type CardButton } from "../cardTemplate.js";
import type { RichMessage } from "../richMessages.js";
import type { CardResult } from "./support.js";
import type { AdminCommandContext } from "./context.js";
import {
  actionButton,
  cardFromText,
  normalize,
  TOGGLE_OFF,
  TOGGLE_ON,
  viewButton,
  type CommandResult,
} from "./support.js";
import {
  ANNOUNCEMENT_NEXT_TIMES,
  MAX_ANNOUNCEMENT_BUTTONS,
  MAX_ANNOUNCEMENTS_PER_GROUP,
  type AnnouncementButton,
  type AnnouncementContentInput,
  type ScheduledAnnouncement,
} from "../scheduledAnnouncements.js";

/**
 * `/announce` 领域模块：机器人**定时发言**（本群群管理员 130 各自配本群）。
 *
 * 口径（用户 2026-10-03 选定，见 TODO §2 的 P0 与 ADR-0062）：
 * - **默认关闭**：新建的任务是停用状态，`/announce on <编号>` 之后才会发；
 * - 时间表是**标准 cron 5 段**（本地时区），`add` 里按位置收 5 段，`set` 里写成 `cron=…`；
 * - 消息形态：`text`（纯文本通道，能 @ 人）/ `card`（Markdown 卡片）；
 *   引用块、按钮、引用回复都只在卡片形态下可用；
 * - 触发幂等：同一任务同一分钟只发一次，重启不重发、错过的时间点不补发；
 * - 每次配置 / 查询都回**后五次执行时间**（确认 cron 写对没有）。
 *
 * 权限：本群 130；这里判一次，服务层不再判（后台写端点同样在 HTTP 层判本群 130）。
 */
export const ANNOUNCE_USAGE = [
  "用法（本群群管理员）：",
  "  /announce                              列出本群定时发言",
  "  /announce add <分 时 日 月 周> <正文>     新建（纯文本、默认停用）",
  "  /announce set <编号> cron=0 9 * * *      改时间表（cron 5 段，本地时区）",
  "  /announce set <编号> mode=card           形态：card（卡片）/ text（纯文本）",
  "  /announce set <编号> title=作业提醒       卡片标题",
  "  /announce set <编号> text=新正文          改正文",
  "  /announce set <编号> quote=要引用的原文    加引用块（Markdown 引用段落）",
  "  /announce set <编号> btn=查看 /activity   加按钮（最多 5 个；btn=clear 清空）",
  "  /announce set <编号> ref=on              发送时引用回复上一条机器人消息（尽力而为）",
  "  /announce on|off <编号>                  启用 / 停用",
  "  /announce show <编号>                    预览（含**后五次执行时间**）",
  "  /announce send <编号>                    立即发一条试试（计入每小时上限）",
  "  /announce del <编号>                     删除",
  "",
  `每个群最多 ${MAX_ANNOUNCEMENTS_PER_GROUP} 条；正文最多 300 字；按钮文字最多 10 字、` +
    `每个按钮要带一条指令。`,
].join("\n");

const PERMISSION_DENIED = "权限不足：定时发言由本群群管理员配置。";
const PRIVATE_HINT =
  "定时发言是**分群**的功能：请在目标群里发送 /announce（或去管理后台「定时发言」页配）。";

type AnnouncementLookup =
  | { ok: true; task: ScheduledAnnouncement; index: number }
  | { ok: false; result: CommandResult };

/** 解析 `<编号>`（列表里的 1-based 序号，够了；也让手输更短）。 */
function lookup(
  ctx: AdminCommandContext,
  groupId: string,
  raw: string | undefined,
): AnnouncementLookup {
  const service = ctx.scheduledAnnouncements!;
  const tasks = service.list(groupId);
  const index = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isInteger(index) || index < 1 || index > tasks.length) {
    return {
      ok: false,
      result: {
        ok: false,
        text:
          tasks.length === 0
            ? `本群还没有定时发言。\n\n${ANNOUNCE_USAGE}`
            : `编号要填 1–${tasks.length}（用 /announce 看列表）。`,
      },
    };
  }
  const task = tasks[index - 1];
  if (!task) {
    return {
      ok: false,
      result: { ok: false, text: `编号要填 1–${tasks.length}。` },
    };
  }
  return { ok: true, task, index };
}

function canConfigure(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
): CommandResult | undefined {
  if (!ctx.scheduledAnnouncements) {
    return { ok: false, text: "定时发言未启用（服务没装配）。" };
  }
  if (!groupId) {
    return { ok: false, text: PRIVATE_HINT };
  }
  if (
    !ctx.permissions.meetsInGroup(
      userId,
      groupId,
      PermissionLevel.GroupAdmin,
    )
  ) {
    return { ok: false, text: PERMISSION_DENIED };
  }
  return undefined;
}

/** 单条任务的预览卡：形态 / 时间表 / 状态 / **后五次执行时间** + 常用动作按钮。 */
function previewCard(
  ctx: AdminCommandContext,
  task: ScheduledAnnouncement,
  index: number,
): CardResult {
  const service = ctx.scheduledAnnouncements!;
  const rich = service.preview(task, {
    groupLabel: ctx.helpers.displayGroup(task.groupId),
    globalEnabled: ctx.platform?.get("scheduledAnnounceEnabled") ?? true,
    count: ANNOUNCEMENT_NEXT_TIMES,
    title: `定时发言 #${index}`,
  });
  const rows: CardButton[][] = [
    [
      actionButton("announce-on", "启用", `/announce on ${index}`),
      actionButton("announce-off", "停用", `/announce off ${index}`),
      actionButton("announce-send", "试发", `/announce send ${index}`),
    ],
    [
      actionButton("announce-del", "删除", `/announce del ${index}`),
      viewButton("announce-list", "列表", "cmd", "run", "/announce"),
      viewButton("help", "帮助", "help", "topic", "announce"),
    ],
  ];
  const keyboard = buildKeyboard(rows);
  const message: RichMessage = {
    ...rich,
    ...(keyboard !== undefined ? { keyboard } : {}),
  };
  return { ok: true, text: rich.text, rich: message };
}

function listCard(ctx: AdminCommandContext, groupId: string): CardResult {
  const service = ctx.scheduledAnnouncements!;
  const tasks = service.list(groupId);
  const globalEnabled = ctx.platform?.get("scheduledAnnounceEnabled") ?? true;
  if (tasks.length === 0) {
    return cardFromText("定时发言", `本群还没有定时发言。\n\n${ANNOUNCE_USAGE}`, {
      rows: [
        [
          viewButton("help", "帮助", "help", "topic", "announce"),
          viewButton("announce-add", "新建提示", "cmd", "run", "/announce add "),
        ],
      ],
    });
  }
  const lines: string[] = [];
  if (!globalEnabled) {
    lines.push("⚠️ 定时发言的**总开关**关着：下面这些任务都不会触发。", "");
  }
  tasks.forEach((task, position) => {
    const index = position + 1;
    const next = service.nextTimes(task.cron, 2);
    lines.push(
      `**#${index}** ${task.enabled ? "✅ 已启用" : "⏸ 已停用"} · \`${task.cron}\``,
      `  ${task.content.mode === "card" ? "卡片" : "纯文本"}` +
        `${task.content.buttons.length > 0 ? `、${task.content.buttons.length} 个按钮` : ""}` +
        `${task.content.quote !== undefined ? "、引用块" : ""} · ${task.content.text.split("\n")[0] ?? ""}`,
      next.length > 0
        ? `  下次：${next.map((time) => shortTime(time)).join(" · ")}`
        : "  下次：算不出来（cron 的日期组合不存在）",
    );
  });
  lines.push(
    "",
    `用 /announce show <编号> 看后 ${ANNOUNCEMENT_NEXT_TIMES} 次执行时间与完整预览；` +
      `/announce on <编号> 启用（新建的任务默认停用）。`,
  );
  return cardFromText("定时发言", lines.join("\n"), {
    rows: [
      [
        viewButton("announce-help", "用法", "help", "topic", "announce"),
        viewButton("announce-refresh", "刷新", "cmd", "run", "/announce"),
      ],
    ],
  });
}

function shortTime(time: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** `/announce`：列表 / 增删改 / 启停 / 预览 / 试发。 */
export async function handleAnnounce(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const denied = canConfigure(ctx, groupId, userId);
  if (denied) {
    return denied;
  }
  const target = groupId!;
  const service = ctx.scheduledAnnouncements!;
  const action = normalize(parts[1]);
  if (action.length === 0 || action === "list" || action === "列表") {
    return listCard(ctx, target);
  }
  if (action === "add" || action === "新增" || action === "新建") {
    // cron 固定占 5 段，正文是剩下的全部（正文里可以有空格）
    const cron = parts.slice(2, 7).join(" ");
    const text = parts.slice(7).join(" ").trim();
    if (cron.trim().length === 0 && text.length === 0) {
      return { ok: false, text: ANNOUNCE_USAGE };
    }
    // 校验顺序交给服务层：cron 先看，再看正文 —— 两者都错时先报 cron
    const created = service.create({
      groupId: target,
      cron,
      content: { mode: "text", text },
      actorId: userId,
    });
    if (!created.ok) {
      return { ok: false, text: `${created.error}\n\n${ANNOUNCE_USAGE}` };
    }
    const list = service.list(target);
    const index = list.findIndex((item) => item.id === created.announcement.id) + 1;
    return previewCard(ctx, created.announcement, index);
  }
  if (action === "set" || action === "设置" || action === "改") {
    const found = lookup(ctx, target, parts[2]);
    if (!found.ok) {
      return found.result;
    }
    const raw = parts.slice(3).join(" ");
    const separator = raw.indexOf("=");
    if (separator < 0) {
      return { ok: false, text: `要写成 字段=值。\n\n${ANNOUNCE_USAGE}` };
    }
    const field = raw.slice(0, separator).trim().toLowerCase();
    const value = raw.slice(separator + 1).trim();
    const patch = toPatch(field, value, found.task);
    if (!patch.ok) {
      return { ok: false, text: patch.error };
    }
    const updated = service.update(found.task.id, patch.patch, userId);
    if (!updated.ok) {
      return { ok: false, text: updated.error };
    }
    return previewCard(ctx, updated.announcement, found.index);
  }
  if (TOGGLE_ON.has(action) || TOGGLE_OFF.has(action)) {
    const found = lookup(ctx, target, parts[2]);
    if (!found.ok) {
      return found.result;
    }
    const enabled = TOGGLE_ON.has(action);
    const result = service.setEnabled(found.task.id, enabled, userId);
    if (!result.ok) {
      return { ok: false, text: result.error };
    }
    if (!result.changed) {
      return {
        ok: true,
        text: `#${found.index} 本来就是${enabled ? "启用" : "停用"}状态。`,
      };
    }
    return previewCard(ctx, result.announcement, found.index);
  }
  if (action === "show" || action === "查看" || action === "预览") {
    const found = lookup(ctx, target, parts[2]);
    if (!found.ok) {
      return found.result;
    }
    return previewCard(ctx, found.task, found.index);
  }
  if (action === "send" || action === "试发" || action === "立即发送") {
    const found = lookup(ctx, target, parts[2]);
    if (!found.ok) {
      return found.result;
    }
    const result = await service.sendNow(found.task.id, userId);
    if (!result.ok) {
      return { ok: false, text: `${result.detail}\n\n${ANNOUNCE_USAGE}` };
    }
    return {
      ok: true,
      text: `已立即发一条（#${found.index}）。这是真实发送，同样计入每小时上限。`,
    };
  }
  if (action === "del" || action === "delete" || action === "删除") {
    const found = lookup(ctx, target, parts[2]);
    if (!found.ok) {
      return found.result;
    }
    const removed = service.remove(found.task.id, userId);
    if (!removed.ok) {
      return { ok: false, text: removed.error };
    }
    return { ok: true, text: `已删除定时发言 #${found.index}（\`${removed.announcement.cron}\`）。` };
  }
  return { ok: false, text: ANNOUNCE_USAGE };
}

type PatchResult =
  | {
      ok: true;
      patch: { cron?: string | undefined; content?: AnnouncementContentInput | undefined };
    }
  | { ok: false; error: string };

/** `set <编号> 字段=值` → 服务层接受的 patch。 */
function toPatch(
  field: string,
  value: string,
  task: ScheduledAnnouncement,
): PatchResult {
  if (field === "cron" || field === "时间" || field === "时间表") {
    return { ok: true, patch: { cron: value } };
  }
  const content: AnnouncementContentInput = {};
  if (field === "text" || field === "正文") {
    content.text = value;
  } else if (field === "title" || field === "标题") {
    content.title = value;
  } else if (field === "quote" || field === "引用") {
    content.quote = value;
  } else if (field === "mode" || field === "形态") {
    const normalized = value.toLowerCase();
    if (["card", "卡片"].includes(normalized)) {
      content.mode = "card";
    } else if (["text", "纯文本", "文本"].includes(normalized)) {
      content.mode = "text";
    } else {
      return { ok: false, error: "形态只能写 card（卡片）或 text（纯文本）。" };
    }
  } else if (field === "ref" || field === "引用回复") {
    if (TOGGLE_ON.has(value.toLowerCase())) {
      content.reference = true;
    } else if (TOGGLE_OFF.has(value.toLowerCase())) {
      content.reference = false;
    } else {
      return { ok: false, error: "引用回复要写 on / off。" };
    }
  } else if (field === "btn" || field === "按钮") {
    const buttons = appendButton(task, value);
    if (typeof buttons === "string") {
      return { ok: false, error: buttons };
    }
    content.buttons = buttons;
  } else {
    return {
      ok: false,
      error:
        `不认识的字段「${field}」。可用：cron / text / title / quote / mode / ref / btn` +
        `（例：/announce set 1 cron=0 9 * * *）`,
    };
  }
  return { ok: true, patch: { content } };
}

/** `btn=` 的值：`<按钮文字> <指令>` 追加一个；`clear` / `-` 清空。 */
function appendButton(
  task: ScheduledAnnouncement,
  value: string,
): AnnouncementButton[] | string {
  const trimmed = value.trim();
  if (["clear", "-", "清空"].includes(trimmed.toLowerCase())) {
    return [];
  }
  const separator = trimmed.search(/\s/u);
  if (separator < 0) {
    return "按钮要写成「按钮文字 指令」，例如：btn=查看 /activity";
  }
  const label = trimmed.slice(0, separator).trim();
  const command = trimmed.slice(separator).trim();
  if (label.length === 0 || command.length === 0) {
    return "按钮要写成「按钮文字 指令」，例如：btn=查看 /activity";
  }
  if (task.content.buttons.length >= MAX_ANNOUNCEMENT_BUTTONS) {
    return `按钮最多 ${MAX_ANNOUNCEMENT_BUTTONS} 个（先用 btn=clear 清空再加）。`;
  }
  return [...task.content.buttons, { label, command }];
}