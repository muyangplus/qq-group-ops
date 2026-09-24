/**
 * 回调按钮 data 的统一编码（见 `docs/CARD-STANDARD.md`）。
 *
 * 格式：`cb:<namespace>:<action>[:<arg>...]`
 * 例：`cb:pending:page:GROUP_OPENID:2`、`cb:menu:open:admin`、`cb:help:topic:rules`
 *
 * 用命名空间 + 动作而不是直接塞指令文本，是为了让"查看/导航"类按钮不经过指令解析，
 * 同时把回调限死在我们自己定义的几个动作上。
 */
export const CALLBACK_PREFIX = "cb:";

export function encodeCallback(
  namespace: string,
  action: string,
  ...args: readonly (string | number)[]
): string {
  return [
    `${CALLBACK_PREFIX}${namespace}`,
    action,
    ...args.map((arg) => String(arg)),
  ].join(":");
}

export interface ParsedCallback {
  namespace: string;
  action: string;
  args: string[];
}

/** 解析回调数据；不是本项目的回调（或格式不对）返回 undefined。 */
export function parseCallback(
  data: string | undefined,
): ParsedCallback | undefined {
  if (!data || !data.startsWith(CALLBACK_PREFIX)) {
    return undefined;
  }
  const [namespace, action, ...args] = data
    .slice(CALLBACK_PREFIX.length)
    .split(":");
  if (!namespace || !action) {
    return undefined;
  }
  return { namespace, action, args };
}

/** 分页回调：`cb:<namespace>:page:<页码>`（最后一页若还需要目标群则排在第 2 位）。 */
export function pageCallback(
  namespace: string,
  page: number,
  ...extra: readonly string[]
): string {
  return encodeCallback(namespace, "page", ...extra, page);
}

/** 从回调参数里取页码（最后一个参数）。 */
export function pageArg(args: readonly string[]): number | undefined {
  const last = args.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const page = Number.parseInt(last, 10);
  return Number.isNaN(page) ? undefined : page;
}

/** 从回调参数里取页码之外的前缀参数（如目标群 openid）。 */
export function pageTargets(args: readonly string[]): string[] {
  return [...args.slice(0, Math.max(0, args.length - 1))];
}

/**
 * 解析指令里的分页参数：`+<页码>`。
 *
 * 用 `+` 前缀是为了不与群号（纯数字）冲突：`/pending 654321 +2`。
 */
export function extractPageToken(parts: readonly string[]): {
  page: number;
  rest: string[];
} {
  let page = 1;
  const rest: string[] = [];
  for (const part of parts.slice(1)) {
    if (/^\+\d+$/u.test(part)) {
      page = Number.parseInt(part.slice(1), 10);
      continue;
    }
    rest.push(part);
  }
  return { page: page >= 1 ? page : 1, rest };
}
