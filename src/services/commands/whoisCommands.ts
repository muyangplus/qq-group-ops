import { renderCard } from "../cardTemplate.js";
import { EXPIRY_ACTOR_ID } from "../joinAudit.js";
import type { AdminCommandContext } from "./context.js";
import {
  WHOIS_MENTION_HINT,
  WHOIS_USAGE,
  formatTime,
  normalize,
  parseMentionTarget,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

/**
 * `/whois` 领域模块：映射查询与「QQ ↔ 个人资料」查询（仅全局超级管理员）。
 *
 * 消息落点：结果**只走私信**（群内静默），细节见 `whoisCard`。
 */
export function handleWhois(
  ctx: AdminCommandContext,
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!ctx.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：仅超级管理员可以查询映射。" };
    }
    if (!ctx.identityMap) {
      return { ok: false, text: "映射服务未启用。" };
    }
    if (normalize(parts[1]) === "profile" || normalize(parts[1]) === "资料") {
      return handleWhoisProfile(ctx, parts.slice(2));
    }
    const input = parts[1]?.trim();
    if (!input) {
      // 不带参数：直接查当前上下文 —— 群聊查当前群，私聊查你自己
      if (groupId) {
        const groupNumber =
          ctx.identityMap.getGroupNumber(groupId) ?? "（未绑定）";
        const shortCode = ctx.display
          ? `\n短码：${ctx.display.group(groupId)}`
          : "";
        return {
          ok: true,
          text: `类型：群（当前群）\n群 ID：${groupId}\n群号：${groupNumber}${shortCode}`,
        };
      }
      const qq = ctx.identityMap.getQq(userId) ?? "（未绑定）";
      const shortCode = ctx.display
        ? `\n短码：${ctx.display.user(userId)}`
        : "";
      return {
        ok: true,
        text: `类型：用户（你自己）\nuserId：${userId}\nQQ：${qq}${shortCode}`,
      };
    }

    // 群内 @ 指定目标：官方 at 段是 `<@!openid>`，可以直接当 userId 用
    const mentionedId = parseMentionTarget(input);
    if (mentionedId) {
      return userMapping(ctx, mentionedId, "用户（群内 @）");
    }
    if (input.startsWith("@")) {
      return { ok: false, text: WHOIS_MENTION_HINT };
    }

    // `#短码`：唯一允许查看真实系统 id 的入口
    const code = ctx.display?.resolveCode(input);
    if (code) {
      const label = `#${code.code}`;
      if (code.kind === "join_request") {
        const lines = [
          "类型：入群申请",
          `短码：${label}`,
          `真实申请 ID：${code.targetId}`,
        ];
        if (ctx.joinAudit.has(code.targetId)) {
          const request = ctx.joinAudit.get(code.targetId);
          lines.push(
            `群：${ctx.helpers.displayGroup(request.groupId)}`,
            `申请人：${ctx.helpers.displayUser(request.userId)}`,
            `理由：${request.reason || "（未填写）"}`,
            `状态：${request.status}`,
            `申请时间：${formatTime(request.createdAt)}`,
          );
          if (request.reviewedAt) {
            lines.push(`处理时间：${formatTime(request.reviewedAt)}`);
          }
          if (request.reviewerId) {
            lines.push(
              `处理人：${
                request.reviewerId === EXPIRY_ACTOR_ID
                  ? "系统（自动过期）"
                  : request.reviewerId === "bot:auto"
                    ? "机器人（按入群规则自动处理）"
                    : ctx.helpers.displayUser(request.reviewerId)
              }`,
            );
          }
          lines.push(
            request.status === "pending"
              ? "本地队列：待审批中"
              : "本地队列：已不在队列（/pending 不会显示）",
          );
        } else {
          lines.push("本地队列：无记录（可能已被保留策略清理）");
        }
        return { ok: true, text: lines.join("\n") };
      }
      if (code.kind === "user") {
        const qq = ctx.identityMap.getQq(code.targetId);
        return {
          ok: true,
          text:
            `类型：用户\n短码：${label}\n真实 userId：${code.targetId}\n` +
            `QQ：${qq ?? "（未绑定）"}`,
        };
      }
      const groupNumber = ctx.identityMap.getGroupNumber(code.targetId);
      return {
        ok: true,
        text:
          `类型：群\n短码：${label}\n真实 group_openid：${code.targetId}\n` +
          `群号：${groupNumber ?? "（未绑定）"}`,
      };
    }

    const resolvedUserId = ctx.identityMap.resolveUserId(input);
    if (resolvedUserId) {
      const qq = ctx.identityMap.getQq(resolvedUserId) ?? "（未绑定）";
      const shortCode = ctx.display
        ? `\n短码：${ctx.display.user(resolvedUserId)}`
        : "";
      return {
        ok: true,
        text: `类型：用户\nuserId：${resolvedUserId}\nQQ：${qq}${shortCode}`,
      };
    }
    const resolvedGroupId = ctx.identityMap.resolveGroupId(input);
    if (resolvedGroupId) {
      const groupNumber =
        ctx.identityMap.getGroupNumber(resolvedGroupId) ?? "（未绑定）";
      const shortCode = ctx.display
        ? `\n短码：${ctx.display.group(resolvedGroupId)}`
        : "";
      return {
        ok: true,
        text: `类型：群\n群 ID：${resolvedGroupId}\n群号：${groupNumber}${shortCode}`,
      };
    }
    return { ok: false, text: `未找到映射。\n\n${WHOIS_USAGE}` };
  }

  /** 用户类映射的统一输出（群内 @ / 短码 / QQ号 都用它）。 */
export function userMapping(
  ctx: AdminCommandContext,
  userId: string,
  label = "用户",
): CommandResult {
    const qq = ctx.identityMap?.getQq(userId) ?? "（未绑定）";
    const shortCode = ctx.display ? `\n短码：${ctx.display.user(userId)}` : "";
    return {
      ok: true,
      text: `类型：${label}\nuserId：${userId}\nQQ：${qq}${shortCode}`,
    };
  }

  /**
   * `/whois` 的投递层：**所有结果只走私信**（A4）。
   *
   * - 私聊里发指令：直接回复（本来就只有本人能看到）；
   * - 群聊里发指令：无论查询成功、**未找到映射**、用法提示还是权限不足，内容都只走私信；
   *   私信成功 → **群里完全静默**（`silent: true`，连「已私信发送」都不回）；
   * - 私信发送失败：群里回唯一一条不含结果的提示（「先私聊机器人再试」），**绝不降级显示结果**。
   *
   * 之所以连「未找到映射」也走私信：查询失败本身就会泄露信息（某个 QQ号 / 短码是否存在）。
   */
export async function whoisCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CardResult> {
    const rows = [
      [
        viewButton("myperm", "我的权限", "cmd", "run", "/myperm"),
        viewButton("help", "查询帮助", "help", "topic", "whois"),
      ],
    ];
    const result = handleWhois(ctx, groupId, userId, parts);
    const card = ctx.helpers.cardify("映射查询", result, rows);
    if (!groupId) {
      return card;
    }
    // 群内：一律尝试私信投递（卡片一定是卡片，兜底用正文构造）
    const rich = card.rich ?? { markdown: card.text, text: card.text };
    const sender = ctx.notifications;
    const sent = sender
      ? await sender.sendPrivateCard(userId, rich)
      : { ok: false, detail: "私信通道未启用" };
    if (sent.ok) {
      // 群内完全静默：内容已经私信出去，群里连「已私信发送」都不回。
      // `silent: true` 由 gatewayRunner 拦下；这里的 rich 只是不含隐私的占位，
      // 万一静默标志失效也不会把查询结果泄露到群里。
      return {
        ok: true,
        text: "结果已私信发送。",
        rich: renderCard({
          title: "映射查询",
          lines: ["结果已私信发送，请查看私聊。"],
        }),
        silent: true,
      };
    }
    const mention = ctx.helpers.mention(groupId, userId).trimEnd();
    const notice = renderCard({
      title: "映射查询",
      lines: [
        ...(mention ? [mention] : []),
        `**结果**：私信发送失败（${sent.detail}），请先私聊机器人再试。\n（/whois 的结果涉及隐私，不会在群里展示）`,
      ],
      rows,
    });
    return { ok: true, text: notice.text, rich: notice };
  }

  /** 把 `@`（官方 at 段）/ QQ号 / userId / `#短码` 解析成 userId（仅用户类）。 */
export function resolveWhoisTargetUserId(
  ctx: AdminCommandContext,
  target: string,
): string | undefined {
    const mentioned = parseMentionTarget(target);
    if (mentioned) {
      return mentioned;
    }
    if (target.startsWith("#")) {
      const code = ctx.display?.resolveCode(target);
      return code && code.kind === "user" ? code.targetId : undefined;
    }
    return ctx.identityMap?.resolveUserId(target);
  }

  /** `/whois profile <@某人|QQ号|userId|#短码>`：QQ↔userId↔短码 + 个人资料（仅超级管理员）。 */
export function handleWhoisProfile(
  ctx: AdminCommandContext,
  parts: readonly string[],
): CommandResult {
    const target = parts[0]?.trim();
    if (!target) {
      return { ok: false, text: WHOIS_USAGE };
    }
    const resolvedUserId = resolveWhoisTargetUserId(ctx, target);
    if (!resolvedUserId) {
      return {
        ok: false,
        text: target.startsWith("@")
          ? WHOIS_MENTION_HINT
          : `未找到该用户的映射。支持：QQ号 / userId / #用户短码。\n\n${WHOIS_USAGE}`,
      };
    }
    const lines = ["类型：用户资料"];
    const qq = ctx.identityMap?.getQq(resolvedUserId) ?? "（未绑定）";
    lines.push(`userId：${resolvedUserId}`, `QQ：${qq}`);
    if (ctx.display) {
      lines.push(`短码：${ctx.display.user(resolvedUserId)}`);
    }
    const profile = ctx.userProfiles?.get(resolvedUserId);
    if (!ctx.userProfiles) {
      lines.push("", "个人资料服务未启用。");
      return { ok: true, text: lines.join("\n") };
    }
    if (!profile) {
      lines.push("", "个人资料：尚未填写");
      return { ok: true, text: lines.join("\n") };
    }
    const grade =
      profile.studentId && profile.year ? `（${profile.year} 级）` : "";
    lines.push(
      "",
      `姓名：${profile.name || "（未填）"}`,
      `学号：${profile.studentId || "（未填）"}${grade}`,
      `班级：${profile.className || "（未填）"}`,
      `学院：${profile.college || "（未填）"}`,
    );
    return { ok: true, text: lines.join("\n") };
  }

  /**
   * 解析审批目标（`/approve`、`/reject` 共用）：
   *
   * - 群内：`/approve <申请>`；
   * - 私信带群：`/approve <群号|#群短码> <申请>`；
   * - 私信不带群：`/approve <申请>`，从本地申请记录反查所属群（短码唯一即可定位）。
   */
