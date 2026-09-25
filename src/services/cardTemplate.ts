import type {
  KeyboardButton,
  KeyboardButtonPermission,
  KeyboardModal,
  KeyboardPayload,
} from "../adapters/qqOfficial.js";
import type { RichMessage } from "./richMessages.js";

/**
 * 统一卡片模板。
 *
 * 官方结构化卡片（Ark）只能接收、不能发送，所以本项目里「卡片」= **Markdown 正文
 * + 内嵌指令按钮**（`msg_type=2` + `keyboard`）。菜单、入群申请卡、活动卡都通过这
 * 个模板渲染，保证：
 *
 * - 布局一致：`## 标题` + 正文行 + 按钮 + 底部提示；
 * - 降级一致：同一份定义同时产出 Markdown、按钮和纯文本，交给 `RichMessageSender`
 *   做「Markdown+按钮 → Markdown → 纯文本」三级降级；
 * - 约束集中：按钮行数、每行按钮数、按钮文字长度等官方限制只在这里校验。
 */
export type CardButtonStyle = 0 | 1 | 3 | 4;

/** 官方限制：按钮文字最多 10 个字符。 */
export const CARD_BUTTON_LABEL_MAX = 10;
/** 官方限制：整个键盘最多 5 行。 */
export const CARD_MAX_ROWS = 5;
/** 官方限制：一行最多 5 个按钮。 */
export const CARD_MAX_BUTTONS_PER_ROW = 5;
/**
 * 项目标准：**一行按钮文字总长 ≤ 12 字**。
 *
 * 官方允许一行 5 个按钮，但实测会非常挤；按「每行总文字量」控制比限制按钮个数更实用
 * （开关类一行 2 个约 8-10 字，导航类一行 3 个约 8-12 字）。超过就要拆行或拆子卡。
 */
export const CARD_MAX_ROW_TEXT_LENGTH = 12;

/** 一个按钮：`command`（指令按钮）或 `callbackData`（回调按钮）二选一。 */
export interface CardButton {
  /** 同一键盘内唯一。 */
  id: string;
  label: string;
  /** 指令按钮（`action.type = 2`）：点击后发送该指令文本。 */
  command?: string | undefined;
  /**
   * 回调按钮（`action.type = 1`）：点击后官方推送 `INTERACTION_CREATE`，
   * `data` 原样回传给机器人（`data.resolved.button_data`）。
   *
   * 注意：官方**没有更新原消息的接口**，回调只能让机器人被动回复一条新消息；
   * 且收到互动事件后必须调用 `PUT /interactions/{id}` 回应，否则客户端一直 loading。
   */
  callbackData?: string | undefined;
  style?: CardButtonStyle | undefined;
  /** 点击后的按钮文字；缺省与 `label` 相同。 */
  visitedLabel?: string | undefined;
  /** 按钮可见性（例如只允许某个接收者点击）。 */
  permission?: KeyboardButtonPermission | undefined;
  /** 二次确认弹窗（官方 `action.modal`，回调与指令按钮都支持）。 */
  modal?: KeyboardModal | undefined;
  unsupportTips?: string | undefined;
}

export interface CardSpec {
  /** 卡片标题，Markdown 渲染为 `## 标题`，纯文本降级为 `【标题】`。 */
  title: string;
  /** 正文行；空字符串表示空行。 */
  lines?: readonly string[] | undefined;
  /** 按钮行；最多 5 行、每行最多 5 个按钮。 */
  rows?: readonly (readonly CardButton[])[] | undefined;
  /** 有按钮时插在按钮前的引导行。 */
  buttonHint?: string | undefined;
  /** 底部提示行。 */
  footer?: readonly string[] | undefined;
}

/** 指令不可用时的兜底提示。 */
const DEFAULT_UNSUPPORT_TIPS = "当前 QQ 版本不支持按钮，请直接复制指令发送";

/** 渲染完整卡片：Markdown + 按钮 + 纯文本降级。 */
export function renderCard(spec: CardSpec): RichMessage {
  const keyboard = buildKeyboard(spec.rows);
  return {
    markdown: renderCardMarkdown(spec),
    text: renderCardText(spec),
    ...(keyboard ? { keyboard } : {}),
  };
}

/** 只渲染 Markdown 正文（含按钮引导行，因为降级后指令列表由 text 承担）。 */
export function renderCardMarkdown(spec: CardSpec): string {
  const lines: string[] = [`## ${spec.title}`, ...(spec.lines ?? [])];
  if (hasButtons(spec.rows)) {
    lines.push("", spec.buttonHint ?? "请点击下方按钮。");
  }
  if (spec.footer && spec.footer.length > 0) {
    lines.push("", ...spec.footer);
  }
  return lines.join("\n");
}

/** 纯文本降级：同样包含标题、正文与每个按钮对应的完整指令。 */
export function renderCardText(spec: CardSpec): string {
  const lines: string[] = [`【${plainTitle(spec.title)}】`];
  for (const line of spec.lines ?? []) {
    lines.push(toPlainLine(line));
  }
  if (spec.footer) {
    for (const line of spec.footer) {
      lines.push(toPlainLine(line));
    }
  }
  const buttons = flattenButtons(spec.rows);
  if (buttons.length > 0) {
    lines.push("", "可用指令：");
    for (const button of buttons) {
      lines.push(`${button.label}：${button.command}`);
    }
  }
  return lines.join("\n");
}

/** 组装官方 `keyboard`；没有按钮时返回 undefined。 */
export function buildKeyboard(
  rows: readonly (readonly CardButton[])[] | undefined,
): KeyboardPayload | undefined {
  const usable = (rows ?? []).filter((row) => row.length > 0);
  if (usable.length === 0) {
    return undefined;
  }
  if (usable.length > CARD_MAX_ROWS) {
    throw new Error(`card keyboard accepts at most ${CARD_MAX_ROWS} rows`);
  }
  const seenIds = new Set<string>();
  return {
    content: {
      rows: usable.map((row, rowIndex) => {
        if (row.length > CARD_MAX_BUTTONS_PER_ROW) {
          throw new Error(
            `card keyboard row ${rowIndex} accepts at most ${CARD_MAX_BUTTONS_PER_ROW} buttons`,
          );
        }
        const width = row.reduce(
          (sum, button) => sum + clampLabel(button.label).length,
          0,
        );
        if (width > CARD_MAX_ROW_TEXT_LENGTH) {
          throw new Error(
            `card keyboard row ${rowIndex} accepts at most ${CARD_MAX_ROW_TEXT_LENGTH} label characters, got ${width}`,
          );
        }
        return {
          buttons: row.map((button) => toKeyboardButton(button, seenIds)),
        };
      }),
    },
  };
}

function hasButtons(
  rows: readonly (readonly CardButton[])[] | undefined,
): boolean {
  return (rows ?? []).some((row) => row.length > 0);
}

function flattenButtons(
  rows: readonly (readonly CardButton[])[] | undefined,
): Array<{ label: string; command: string }> {
  const result: Array<{ label: string; command: string }> = [];
  for (const button of (rows ?? []).flat()) {
    // 回调按钮没有可复制的指令文本，纯文本降级由调用方在正文里给出替代指令
    if (button.label.length > 0 && button.command !== undefined) {
      result.push({ label: button.label, command: button.command });
    }
  }
  return result;
}

function toKeyboardButton(
  button: CardButton,
  seenIds: Set<string>,
): KeyboardButton {
  if (seenIds.has(button.id)) {
    // 官方要求同一键盘内按钮 id 唯一；重复说明调用方写错了，直接抛错便于测试发现。
    throw new Error(`duplicated keyboard button id: ${button.id}`);
  }
  seenIds.add(button.id);

  const isCallback = button.callbackData !== undefined;
  if (isCallback === (button.command !== undefined)) {
    throw new Error(
      `card button ${button.id} 必须二选一：command（指令按钮）或 callbackData（回调按钮）`,
    );
  }

  const label = clampLabel(button.label);
  const data = isCallback ? button.callbackData! : button.command!;
  return {
    id: button.id,
    label,
    visitedLabel: clampLabel(button.visitedLabel ?? button.label),
    ...(button.style !== undefined ? { style: button.style } : {}),
    action: isCallback
      ? {
          type: 1,
          data,
          ...(button.permission !== undefined
            ? { permission: button.permission }
            : {}),
          unsupportTips: button.unsupportTips ?? DEFAULT_UNSUPPORT_TIPS,
          // 回调按钮同样支持二次确认：报名 / 取消报名 / 取消活动这类不可逆动作
          // 需要先弹官方 modal，避免误点（官方 `action.modal` 对 type=1 有效）。
          ...(button.modal !== undefined ? { modal: button.modal } : {}),
        }
      : {
          type: 2,
          data,
          ...(button.permission !== undefined
            ? { permission: button.permission }
            : {}),
          // 单聊会自动发送（客户端 8983+）；群聊里点击只是把指令填进输入框。
          enter: true,
          reply: false,
          unsupportTips: button.unsupportTips ?? DEFAULT_UNSUPPORT_TIPS,
          ...(button.modal !== undefined ? { modal: button.modal } : {}),
        },
  };
}

function clampLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > CARD_BUTTON_LABEL_MAX
    ? trimmed.slice(0, CARD_BUTTON_LABEL_MAX)
    : trimmed;
}

function plainTitle(title: string): string {
  return title.replace(/^#+\s*/u, "").trim();
}

/** Markdown → 纯文本的轻量转换（只处理模板会产出的几种写法）。 */
function toPlainLine(line: string): string {
  return line
    .replace(/^#{1,6}\s*/u, "")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/gu, (_match, label: string, url: string) =>
      label.trim().length > 0 ? `${label} (${url})` : url,
    )
    .replace(/\*\*/gu, "")
    .replace(/^>\s?/u, "")
    .trimEnd();
}

/** 单行化 + Markdown 转义（正文里的用户数据必须走这个函数）。 */
export function escapeCardText(text: string, maxLength = 200): string {
  return singleLine(text)
    .replace(/[\\`*_~#>]/gu, (char) => `\\${char}`)
    .slice(0, maxLength);
}

/** 压成单行。 */
export function singleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 多行文本转成 Markdown 引用行。 */
export function quoteCardLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => `> ${line.trim()}`.trimEnd());
}
