import { renderCard } from "../cardTemplate.js";
import type { CardButton } from "../cardTemplate.js";
import { getLogger } from "../../core/logger.js";
import { TEST_MENU_PAGE_COUNT, buildTestMenuCard } from "../testMenu.js";
import type { AdminCommandContext } from "./context.js";
import {
  AT_ALL_PROBES,
  actionButton,
  cardFromText,
  normalize,
  stripMarkdownForText,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

const log = getLogger("test-commands");

/**
 * `/testmenu` 与 `/testat`：回调翻页试验与「@ 渲染真机自检」（仅全局超级管理员）。
 */
export function handleTestMenu(
  ctx: AdminCommandContext,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!ctx.permissions.isSuperAdmin(userId)) {
      return {
        ok: false,
        text: "权限不足：/testmenu 需要全局超级管理员权限。",
        noMention: true,
      };
    }
    const raw = parts[1];
    let page = 1;
    if (raw !== undefined) {
      const parsed = Number.parseInt(raw, 10);
      if (
        Number.isNaN(parsed) ||
        parsed < 1 ||
        parsed > TEST_MENU_PAGE_COUNT
      ) {
        return {
          ok: false,
          text: `页码范围 1-${TEST_MENU_PAGE_COUNT}，例如 /testmenu 2`,
          noMention: true,
        };
      }
      page = parsed;
    }
    const card = buildTestMenuCard(page);
    // §F1：test 模块按现状豁免，不在群里自动 @
    return { ok: true, text: card.text, rich: card, noMention: true };
  }

  /**
   * `/testat [all]`：真机自检「群里 @ 到底怎么发才生效」（仅全局超级管理员）。
   *
   * 已实测（本机真机）：**Markdown 卡片里的 `<@!openid>` 生效**，纯文本 `content` 里的
   * `<@!openid>` 与 `@everyone` 都不生效 —— 与官方内嵌格式文档的暗示相反。所以：
   *
   * 1. 纯文本 `content` + `<@!我>`（实测无效，保留作对照）；
   * 2. Markdown 卡片，首行 `<@!我>`（实测有效）；
   * 3. Markdown 卡片，正文中间的 `<@!我>`（实测有效）；
   * 4. 仅 `/testat all`：一组 @全体候选写法（markdown 里的 `@everyone` / `<@!all>` /
   *    `<@!everyone>` / `@全体成员` / `<@all>`，以及纯文本里的 `<@!all>` / `<@all>` / `@everyone`），
   *    找出哪个（如果有）真能 @ 全群。`<@all>` 与 `@everyone` 是 R1 抓到的官方入站原文形态。
   *
   * 最后回一张汇总卡，请操作者回答哪几条真的 @ 到了，据此决定活动发布的 @全体实现方式。
   */
export async function handleTestAt(
  ctx: AdminCommandContext,
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    if (!ctx.permissions.isSuperAdmin(userId)) {
      return {
        ok: false,
        text: "权限不足：/testat 需要全局超级管理员权限。",
        noMention: true,
      };
    }
    const sender = ctx.richMessages;
    if (!sender) {
      return { ok: false, text: "发送通道未启用，无法自检。", noMention: true };
    }
    if (!groupId) {
      return {
        ok: false,
        text:
          "请在群里执行 /testat（要验证的是群消息里的 @ 渲染）。\n" +
          "额外验证 @全体成员候选写法：/testat all（会真的打扰全群，请谨慎）。",
        noMention: true,
      };
    }
    const wantAll = normalize(parts[1]) === "all" || parts[1] === "全体";
    const mention = `<@!${userId}>`;
    const lines: string[] = [];
    const failures: string[] = [];

    const record = async (
      label: string,
      result: { ok: boolean; detail: string; mode: string },
    ): Promise<void> => {
      lines.push(
        `${label}：${result.ok ? `已发送（${result.mode}）` : `失败（${result.detail}）`}`,
      );
      if (!result.ok) {
        failures.push(label);
      }
    };

    const first = await sender.sendPlainToGroup(
      groupId,
      `【@测试 1】纯文本 content + 提及：${mention} 这条走 msg_type=0。`,
    );
    await record("1. 纯文本 `content` + `<@!我>`（已知无效，对照）", first);

    const cardFirst = await sender.sendToGroup(groupId, {
      markdown: `${mention}\n\n【@测试 2】这是 Markdown 卡片，**提及放在第一行**。`,
      text: `【@测试 2】Markdown 卡片，提及放在第一行：${mention}`,
    });
    await record("2. Markdown 卡片（首行 @，已知有效）", cardFirst);

    const cardMiddle = await sender.sendToGroup(groupId, {
      markdown: `【@测试 3】这是 Markdown 卡片，提及放在**正文中间**：${mention} 后面还有字。`,
      text: `【@测试 3】Markdown 卡片，提及在正文中间：${mention}`,
    });
    await record("3. Markdown 卡片（正文中间 @，已知有效）", cardMiddle);

    if (wantAll) {
      let index = 4;
      for (const probe of AT_ALL_PROBES) {
        const result =
          probe.kind === "card"
            ? await sender.sendToGroup(groupId, {
                markdown: probe.content,
                text: stripMarkdownForText(probe.content),
              })
            : await sender.sendPlainToGroup(groupId, probe.content);
        await record(`${index}. ${probe.label}`, result);
        index += 1;
      }
    }
    const sent = lines.length;

    const card = renderCard({
      title: "@ 测试结果",
      lines: [
        `已在群里发送 ${sent} 条测试消息（本条是汇总）：`,
        ...lines,
        "",
        "**请回复：哪几条真的 @ 到了你 / 全体员工？**",
        "判断标准：昵称/「全体成员」被高亮、收到 @ 提醒、手机收到通知。",
        wantAll
          ? `上面第 4–${sent} 条是 @全体候选写法。**已知结论（2026-09-26 真机）：8 种写法全部不生效，机器人无法 @全体**；若这次有任意一条真的提醒了全群，说明平台放开了能力，请把编号反馈给我。`
          : "想继续找能真正 @ 全群的写法：点下面按钮（会再次打扰全群）。",
        failures.length > 0
          ? `发送失败的条目：${failures.join("、")}`
          : "",
        "",
        `操作人：${ctx.helpers.displayUser(userId)}`,
      ].filter((line) => line.length > 0),
      rows: [
        [
          actionButton("again", "再测一次", "/testat"),
          actionButton("all", "@全体候选", "/testat all", {
            style: 3,
            modal: {
              content: "会向全群发多条 @全体候选消息，确认发送？",
              confirmText: "发送",
              cancelText: "取消",
            },
          }),
        ],
      ],
      footer: ["测完请把有效的编号告诉开发者，据此实现活动发布的 @全体。"],
    });
    // §F1：test 模块按现状豁免，不在群里自动 @
    return { ok: true, text: card.text, rich: card, noMention: true };
  }

/** `/test`：自检结果卡 + 常用入口。 */
export function testCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
): CardResult {
  if (!ctx.permissions.canReviewContent(userId, groupId ?? "")) {
    log.warn("test permission denied", { groupId, userId });
    const card = renderCard({
      title: "权限不足",
      lines: ["需要审核员或以上权限。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card, noMention: true };
  }
  log.info("test command", { groupId, userId });
  const rows: CardButton[][] = [];
  if (groupId) {
    rows.push([
      viewButton("refresh", "刷新", "test", "view", groupId),
      viewButton("pending", "待审批", "pending", "page", groupId, 1),
      viewButton("rules", "群规则", "rules", "view", groupId),
    ]);
  } else {
    rows.push([viewButton("help", "指令帮助", "help", "home")]);
  }
  const lines = [
    "测试成功：机器人已响应。",
    groupId ? `**群**：${ctx.helpers.displayGroup(groupId)}` : "**当前会话**：私聊",
    `**用户**：${ctx.helpers.displayUser(userId)}`,
  ];
  if (groupId) {
    lines.push(`**待审批申请**：${ctx.joinAudit.pending(groupId).length}`);
    lines.push(
      `**全量消息模式**：${ctx.groupMessageMode?.get(groupId) ?? "unknown"}`,
    );
  }
  const card = cardFromText("自检结果", lines.join("\n"), {
    rows,
    footer: ["机器人状态异常时：查看日志 logs/qq-group-ops.log"],
  });
  // §F1：test 模块按现状豁免，不在群里自动 @
  return { ...card, noMention: true };
}

/** `/test` 的指令入口（回调 renderer 也走它）。 */
export function handleTest(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
): CommandResult {
  return testCard(ctx, groupId, userId);
}


