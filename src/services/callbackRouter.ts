import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { getLogger } from "../core/logger.js";
import { parseCallback, type ParsedCallback } from "./callbackData.js";
import type { InteractionEvent, InteractionHandler } from "./eventRouter.js";
import { withGroupMention } from "./groupMention.js";
import type { RichMessage, RichMessageSender } from "./richMessages.js";

const log = getLogger("callback-router");

/**
 * 回调 renderer：把回调数据渲染成要发送的卡片。
 *
 * 约定（见 `docs/CARD-STANDARD.md`）：
 * - **权限校验必须在 renderer 内部完成**（与对应指令 handler 用同一套判断）；
 * - 无权访问时返回一张说明卡片，而不是静默什么都不发；
 * - 返回 `undefined` 表示这个回调不该产生消息。
 */
export type CallbackRenderer = (
  parsed: ParsedCallback,
  event: InteractionEvent,
) => Promise<RichMessage | undefined>;

export interface CallbackRouterOptions {
  api: QQOfficialAPI;
  sender: RichMessageSender;
  renderers: ReadonlyMap<string, CallbackRenderer>;
}

/**
 * 互动事件（按钮回调）总入口。
 *
 * 官方要求收到 `INTERACTION_CREATE` 后必须回应 `PUT /interactions/{id}`，否则客户端会一直
 * loading 到超时；回应体只有 `{ code }`，**没有更新原消息的能力**，也**不能**把 interaction id
 * 当 `msg_id` 发被动消息（真机实测群聊返回 400）。所以这里的固定流程是：
 *
 *   回包（止住 loading）→ renderer 渲染卡片 → 主动发送新卡片
 *
 * 导航类按钮因此是"点击即来一张新卡"，旧卡片保留在聊天记录里。
 */
export class CallbackRouter implements InteractionHandler {
  private readonly api: QQOfficialAPI;
  private readonly sender: RichMessageSender;
  private readonly renderers: ReadonlyMap<string, CallbackRenderer>;

  public constructor(options: CallbackRouterOptions) {
    this.api = options.api;
    this.sender = options.sender;
    this.renderers = options.renderers;
  }

  public async handle(
    event: InteractionEvent,
  ): Promise<{ handled: boolean; detail: string }> {
    const parsed = parseCallback(event.buttonData);
    if (!parsed) {
      // 不是本项目的回调也要回包，否则客户端一直 loading
      const acked = await this.ack(event.interactionId);
      return {
        handled: false,
        detail: acked ? "unknown_callback" : "unknown_callback_ack_failed",
      };
    }

    const acked = await this.ack(event.interactionId);
    const suffix = acked ? "" : "_ack_failed";
    const renderer = this.renderers.get(parsed.namespace);
    if (!renderer) {
      log.debug("no renderer for callback", {
        namespace: parsed.namespace,
        action: parsed.action,
      });
      return { handled: false, detail: `no_route:${parsed.namespace}${suffix}` };
    }

    const card = await renderer(parsed, event);
    if (!card) {
      return {
        handled: false,
        detail: `${parsed.namespace}:${parsed.action}_no_card${suffix}`,
      };
    }
    const mode = await this.send(event, card, {
      // §F1：群里回复卡片在首行 @ 点击者；test 模块（/test、/testmenu）按现状豁免。
      mention:
        parsed.namespace !== "test" && parsed.namespace !== "testmenu",
    });
    return {
      handled: true,
      detail: `${parsed.namespace}:${parsed.action}_${mode}${suffix}`,
    };
  }

  /** 回应互动事件；失败只记日志（卡片仍会发出去）。 */
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

  /** 主动发送卡片（群聊优先用群，其次单聊）。 */
  private async send(
    event: InteractionEvent,
    card: RichMessage,
    options: { mention: boolean },
  ): Promise<string> {
    if (event.groupId) {
      const reply =
        options.mention && event.userId
          ? withGroupMention(card, event.userId)
          : card;
      return describeSend(await this.sender.sendToGroup(event.groupId, reply));
    }
    if (event.userId) {
      return describeSend(await this.sender.sendToUser(event.userId, card));
    }
    return "no_target";
  }
}

function describeSend(result: {
  ok: boolean;
  mode: string;
  detail: string;
}): string {
  if (!result.ok) {
    return "failed";
  }
  return result.detail.length > 0
    ? `${result.mode}+${result.detail}`
    : result.mode;
}
