import { getLogger } from "../core/logger.js";
import { renderCard } from "./cardTemplate.js";
import type { GroupConfigStore } from "./groupConfig.js";
import { withGroupMention } from "./groupMention.js";
import type { RichMessageSender } from "./richMessages.js";

const log = getLogger("welcome");

/** 欢迎语里的成员占位符（发送时替换成 @ 该成员）。 */
export const WELCOME_MEMBER_PLACEHOLDER = "{成员}";

/**
 * @ 一个成员的写法。
 *
 * 真机踩过两次相反的坑（两处注释都在仓库里）：纯文本 `content` 的内嵌提及与
 * Markdown 卡片的 `<@!openid>`，谁生效与客户端版本有关。所以迎新**两条通道都发**
 * （先纯文本、再卡片），任一条生效就能 @ 到人；两条都失败只记日志。
 */
export function mentionMember(memberId: string): string {
  return `<@!${memberId}>`;
}

export interface WelcomeDeps {
  configStore: GroupConfigStore;
  /** 群消息发送器（需要纯文本通道 + 富消息通道）。 */
  sender: Pick<RichMessageSender, "sendPlainToGroup" | "sendToGroup">;
}

/** `disabled` = 没开迎新（或欢迎语为空）；`sent`/`failed` = 两条通道的结果。 */
export type WelcomeOutcome = "disabled" | "sent" | "failed";

/**
 * 迎新（**仅群内**，用户确认不做私信欢迎）。
 *
 * 1. 纯文本通道发一条 @ 新成员的消息（官方内嵌提及在 `content` 里生效）；
 * 2. 再发一张欢迎卡（正文里同样 @ 他，按钮/富消息不可用时由发送层自动降级）。
 *
 * 任一步失败只记日志：迎新是尽力而为，失败不能影响机器人其它功能。
 */
export async function sendWelcome(
  deps: WelcomeDeps,
  groupId: string,
  memberId: string,
): Promise<WelcomeOutcome> {
  const config = deps.configStore.get(groupId);
  const template = config.welcomeMessage.trim();
  if (!config.welcomeEnabled || template.length === 0) {
    return "disabled";
  }

  const mention = mentionMember(memberId);
  const hasPlaceholder = template.includes(WELCOME_MEMBER_PLACEHOLDER);
  const body = hasPlaceholder
    ? template.replaceAll(WELCOME_MEMBER_PLACEHOLDER, mention)
    : template;
  const card = hasPlaceholder
    ? renderCard({ title: "欢迎新成员", lines: body.split("\n") })
    : withGroupMention(
        renderCard({ title: "欢迎新成员", lines: body.split("\n") }),
        memberId,
      );

  const plain = await deps.sender.sendPlainToGroup(
    groupId,
    hasPlaceholder ? body : `${mention} ${body}`,
  );
  if (!plain.ok) {
    log.warn("welcome plain text failed", { groupId, detail: plain.detail });
  }

  const rich = await deps.sender.sendToGroup(groupId, card);
  if (!rich.ok) {
    log.warn("welcome card failed", { groupId, detail: rich.detail });
  }

  return plain.ok || rich.ok ? "sent" : "failed";
}
