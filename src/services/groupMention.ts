import type { RichMessage } from "./richMessages.js";

/**
 * §F1：群内回复统一在首行 @ 本次操作的发起人。
 *
 * 真机结论（见 `/testat` 自检）：官方只有 **Markdown 卡片正文里的 `<@!openid>`** 能真正 @ 到人，
 * 纯文本 `content` 里的 `<@!openid>` 不生效。所以这里只改 `message.markdown`，**不动纯文本降级**——
 * 在降级通道里写 @ 既无效，又会多出一行噪声（能力边界记在 CHANGELOG 备注里）。
 *
 * 已经带 @ 的卡片保持原样：`/whois` 私信失败提示、关键词命中卡、回调结果卡等都由 handler
 * 自己把 `<@!openid>` 放在标题后的首行，这里不再重复加。
 */
export function withGroupMention(
  message: RichMessage,
  userId: string,
): RichMessage {
  const userId2 = userId.trim();
  if (userId2.length === 0 || alreadyMentioned(message.markdown)) {
    return message;
  }
  // 统一放在**标题下一行**（真机要求：不出现「有的在标题上、有的在标题下」）
  const lines = message.markdown.split("\n");
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  const hasTitle =
    firstContent >= 0 && /^#{1,6}\s+/u.test(lines[firstContent]!.trim());
  const insertAt = hasTitle ? firstContent + 1 : 0;
  lines.splice(insertAt, 0, `<@!${userId2}>`);
  return { ...message, markdown: lines.join("\n") };
}

/**
 * 判断 Markdown 是否已经 @ 了人。
 *
 * 卡片的第一个非空行通常是 `## 标题`，@ 行紧跟在标题后，因此检查**前三个非空行**里有没有
 * 以 `<@!` 开头的行；纯文本通知（第一行就是 @）同样命中。
 */
export function alreadyMentioned(markdown: string): boolean {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .some((line) => line.startsWith("<@!"));
}
