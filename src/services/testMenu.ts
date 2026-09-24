import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { getLogger } from "../core/logger.js";
import { renderCard, type CardButton } from "./cardTemplate.js";
import type { InteractionEvent } from "./eventRouter.js";
import type { PermissionService } from "./permissions.js";
import type {
  RichMessage,
  RichMessageSender,
  RichSendResult,
} from "./richMessages.js";

const log = getLogger("test-menu");

/**
 * `/testmenu`：官方**回调按钮**翻页试验（仅全局超级管理员）。
 *
 * 官方能力边界（已核对文档）：
 * - 回调按钮 `action.type = 1`：点击后官方推 `INTERACTION_CREATE`（`type=11`），
 *   `data.resolved.button_data` 带回按钮定义里的 `data`；
 * - 收到互动事件后**必须**调 `PUT /interactions/{id}` 回应，否则客户端一直 loading 到超时；
 * - **没有"更新原消息"的接口**，所以翻页只能靠"被动回复一条新消息"实现 ——
 *   互动事件的 `id` 可以当 `msg_id` 用（官方说明：用于被动消息发送和互动回调）；
 * - 弹窗确认/指令按钮与回调按钮可以混在同一个键盘里。
 *
 * 双通道设计：回调按钮翻页为主；卡片正文与第二行按钮给出 `/testmenu <页码>`，
 * 便于回调未开通时手动翻页。回调发送失败时 `RichMessageSender` 会自动改用主动发送。
 */
export const TEST_MENU_PAGE_COUNT = 3;
/** 回调按钮 data 前缀：`testmenu:page:2`。 */
export const TEST_MENU_CALLBACK_PREFIX = "testmenu:page:";

export function clampTestMenuPage(page: number): number {
  if (!Number.isFinite(page)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(page), 1), TEST_MENU_PAGE_COUNT);
}

export function testMenuCallbackData(page: number): string {
  return `${TEST_MENU_CALLBACK_PREFIX}${clampTestMenuPage(page)}`;
}

/** 解析回调数据：是 `/testmenu` 的回调才返回页码。 */
export function parseTestMenuCallback(
  data: string | undefined,
): number | undefined {
  if (!data || !data.startsWith(TEST_MENU_CALLBACK_PREFIX)) {
    return undefined;
  }
  const page = Number.parseInt(data.slice(TEST_MENU_CALLBACK_PREFIX.length), 10);
  return Number.isNaN(page) ? undefined : clampTestMenuPage(page);
}

/** 渲染第 `page` 页（自动收敛到 1-3）。 */
export function buildTestMenuCard(page: number): RichMessage {
  const current = clampTestMenuPage(page);
  const rows: CardButton[][] = [];

  const callbackRow: CardButton[] = [];
  if (current > 1) {
    callbackRow.push(callbackButton("prev", "上一页", current - 1));
  }
  if (current < TEST_MENU_PAGE_COUNT) {
    callbackRow.push(callbackButton("next", "下一页", current + 1));
  }
  callbackRow.push(callbackButton("home", "返回第 1 页", 1));
  rows.push(callbackRow);

  // 双通道：键盘能用但互动事件没开通时，至少还能用指令按钮翻页
  if (current < TEST_MENU_PAGE_COUNT) {
    rows.push([
      {
        id: "cmd-next",
        label: `指令翻页 ${current + 1}`,
        command: `/testmenu ${current + 1}`,
      },
    ]);
  }

  return renderCard({
    title: `测试菜单（第 ${current} / ${TEST_MENU_PAGE_COUNT} 页）`,
    lines: [
      "用于验证官方**回调按钮**（`INTERACTION_CREATE`）翻页。",
      `**当前页**：第 ${current} / ${TEST_MENU_PAGE_COUNT} 页`,
      "",
      `第 ${current} 页文案：这是翻页试验的第 ${current} 页。`,
      `手动翻页：/testmenu <页码>（1-${TEST_MENU_PAGE_COUNT}）`,
    ],
    rows,
    buttonHint: "点击翻页：",
    footer: [
      "点按钮由机器人被动回复新的一页（官方不支持更新原卡片）；发送失败会自动改用主动发送。",
    ],
  });
}

function callbackButton(
  id: string,
  label: string,
  page: number,
): CardButton {
  return {
    id,
    label,
    callbackData: testMenuCallbackData(page),
    style: id === "next" ? 1 : 0,
    permission: { type: 2 },
  };
}

export interface TestMenuDependencies {
  api: QQOfficialAPI;
  sender: RichMessageSender;
  permissions: PermissionService;
}

export interface InteractionOutcome {
  handled: boolean;
  detail: string;
}

export class TestMenuService {
  private readonly api: QQOfficialAPI;
  private readonly sender: RichMessageSender;
  private readonly permissions: PermissionService;

  public constructor(dependencies: TestMenuDependencies) {
    this.api = dependencies.api;
    this.sender = dependencies.sender;
    this.permissions = dependencies.permissions;
  }

  /** 处理按钮回调：回包 + 把目标页作为新消息发出去。 */
  public async handle(event: InteractionEvent): Promise<InteractionOutcome> {
    const page = parseTestMenuCallback(event.buttonData);
    if (page === undefined) {
      // 不是本菜单的回调也要回包，否则客户端一直 loading
      const acked = await this.ack(event.interactionId);
      return {
        handled: false,
        detail: acked ? "unknown_callback" : "unknown_callback_ack_failed",
      };
    }

    const acked = await this.ack(event.interactionId);
    const suffix = acked ? "" : "_ack_failed";
    if (!event.userId) {
      return { handled: false, detail: `missing_user${suffix}` };
    }
    if (!this.permissions.isSuperAdmin(event.userId)) {
      // 卡片可能被转发到别的群，点的人不一定有权限：回包并说明原因
      await this.reply(event, {
        markdown: "仅全局超级管理员可以翻页：/testmenu",
        text: "仅全局超级管理员可以翻页：/testmenu",
      });
      return { handled: true, detail: `permission_denied${suffix}` };
    }

    const mode = await this.reply(event, buildTestMenuCard(page));
    return { handled: true, detail: `page_${page}_${mode}${suffix}` };
  }

  /** 回应互动事件；失败只记日志（客户端可能一直 loading，但卡片仍会发出去）。 */
  private async ack(interactionId: string): Promise<boolean> {
    try {
      await this.api.respondInteraction(interactionId, 0);
      return true;
    } catch (error) {
      log.warn("interaction ack failed", {
        interactionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 回复目标页：用 interaction id 当 `msg_id` 走被动消息；
   * `RichMessageSender` 内部会在被动失败时自动改用主动发送（用户仍能看到新卡片）。
   */
  private async reply(
    event: InteractionEvent,
    card: RichMessage,
  ): Promise<string> {
    if (event.groupId) {
      return describeSend(
        await this.sender.replyToGroup(event.groupId, card, {
          msgId: event.interactionId,
        }),
      );
    }
    if (event.userId) {
      return describeSend(
        await this.sender.replyToUser(event.userId, card, {
          msgId: event.interactionId,
        }),
      );
    }
    return "no_target";
  }
}

/** 把发送结果压成一句可写进日志/返回值的说明（含降级原因）。 */
function describeSend(result: RichSendResult): string {
  if (!result.ok) {
    return "failed";
  }
  return result.detail.length > 0 ? `${result.mode}+${result.detail}` : result.mode;
}
