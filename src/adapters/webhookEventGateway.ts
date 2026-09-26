import Fastify, { type FastifyInstance } from "fastify";
import { getLogger } from "../core/logger.js";
import type { OfficialEventMapper } from "./qqOfficialEventMapper.js";
import type { QQEvent } from "../services/eventRouter.js";
import type { EventGateway, EventHandler } from "./eventGateway.js";
import {
  deriveWebhookKeyPair,
  signWebhookValidation,
  verifyWebhookSignature,
  type WebhookKeyDerivation,
  type WebhookKeyPair,
  type WebhookSignContent,
} from "./qqWebhookSignature.js";

const log = getLogger("webhook-gateway");

/** 官方回调体：`op=0` 事件推送 / `op=13` URL 校验握手。 */
interface WebhookBody {
  op?: number;
  /** 事件类型（`op=0` 时用于驱动 `QQOfficialEventMapper`）。 */
  t?: string;
  /** 事件数据（`op=0` = 事件体；`op=13` = `{ plain_token, event_ts }`）。 */
  d?: unknown;
}

export interface WebhookGatewayOptions {
  /** 机器人密钥（AppSecret）或独立的回调密钥；用于派生 Ed25519 密钥对。 */
  secret: string;
  /** 监听端口（默认 3000；通常由反向代理转发到 443）。 */
  port: number;
  /** 监听地址（默认 `127.0.0.1`：只让本机反代访问；直接暴露时才用 0.0.0.0）。 */
  host?: string | undefined;
  /** 回调路径（默认 `/webhook/qq`，必须与开放平台后台填写的一致）。 */
  path?: string | undefined;
  /** 事件映射器（与 WebSocket 网关共用同一份）。 */
  mapper: OfficialEventMapper;
  /** 注入密钥对（测试用；缺省时由 secret 派生）。 */
  keyPair?: WebhookKeyPair | undefined;
  /** 密钥派生策略（`WEBHOOK_KEY_DERIVATION`，默认 `auto`）。 */
  keyDerivation?: WebhookKeyDerivation | undefined;
  /** 校验握手签名内容（`WEBHOOK_SIGN_CONTENT`，默认 `ts_token`）。 */
  signContent?: WebhookSignContent | undefined;
}

/**
 * QQ 官方 Webhook 事件通道（§D5）。
 *
 * 与 WebSocket 网关**二选一**（`EVENT_MODE=websocket|webhook`，避免同一条事件被两条通道重复消费）：
 * 平台把事件 POST 到我们的 HTTPS 回调地址，我们验签 → 解析 → 交给同一套 `eventRouter`。
 *
 * 实现要点：
 * - 原始请求体必须保留（签名是对 `timestamp + rawBody` 做的），所以注册了自定义 content-type parser；
 * - `op=13` 是 URL 校验握手（平台不签名），回 `{plain_token, signature}`；
 * - `op=0` 是事件推送，**验签失败一律 401**（fail-closed），成功则先回 200 再异步处理
 *   （避免我们发卡片耗时导致平台超时重推 → 重复处理）；
 * - 事件处理按接收顺序**串行化**，保持与 WebSocket 网关一致的顺序语义；
 * - 按钮回调用的是 `PUT /interactions/{id}`（REST，与事件通道无关），因此 webhook 模式下照旧可用。
 */
export class WebhookEventGateway implements EventGateway {
  private readonly keyPair: WebhookKeyPair;
  private readonly port: number;
  private readonly host: string;
  private readonly path: string;
  private readonly mapper: OfficialEventMapper;
  private readonly signContent: WebhookSignContent;
  private server: FastifyInstance | undefined;
  private handler: EventHandler | undefined;
  /** 事件处理串行队列（先回 ACK，再按序处理）。 */
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  public constructor(options: WebhookGatewayOptions) {
    this.keyPair =
      options.keyPair ??
      deriveWebhookKeyPair(options.secret, options.keyDerivation ?? "auto");
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
    this.path = options.path ?? "/webhook/qq";
    this.mapper = options.mapper;
    this.signContent = options.signContent ?? "ts_token";
  }

  public get isRunning(): boolean {
    return this.server !== undefined;
  }

  /** 已接收但还没处理完的事件数（排查/测试用）。 */
  public get pending(): number {
    return this.queued;
  }

  /**
   * 实际监听端口。
   *
   * 传 `port: 0` 时由系统分配，这里返回真实端口（测试与真机联调都用得上）。
   */
  public get listeningPort(): number | undefined {
    const address = this.server?.server.address();
    return address !== null && typeof address === "object" ? address.port : undefined;
  }

  /** 等待队列里的事件处理完（测试与优雅退出用）。 */
  public async flush(): Promise<void> {
    await this.queue;
  }

  public async start(handler: EventHandler): Promise<void> {
    if (this.server) {
      return;
    }
    this.handler = handler;
    const server = Fastify({ logger: false });
    // 保留原始请求体：签名校验用的是 `timestamp + rawBody`，不是解析后的 JSON
    server.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );
    server.post(this.path, async (request, reply) => {
      const rawBody = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(
            typeof request.body === "string" ? request.body : "",
            "utf8",
          );
      let payload: WebhookBody;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as WebhookBody;
      } catch {
        log.warn("webhook body is not valid json", { path: this.path });
        return reply.code(400).send({ error: "invalid json" });
      }

      // 1) URL 校验握手（平台不签名）
      if (payload.op === 13) {
        const data = (payload.d ?? {}) as {
          plain_token?: unknown;
          event_ts?: unknown;
        };
        const plainToken =
          typeof data.plain_token === "string" ? data.plain_token : undefined;
        const eventTs =
          typeof data.event_ts === "string" ? data.event_ts : undefined;
        if (!plainToken || !eventTs) {
          log.warn("webhook validation request missing fields");
          return reply.code(400).send({ error: "missing plain_token/event_ts" });
        }
        const signature = signWebhookValidation({
          privateKey: this.keyPair.privateKey,
          eventTs,
          plainToken,
          content: this.signContent,
        });
        log.info("webhook url validation answered", {
          seedSource: this.keyPair.seedSource,
          signContent: this.signContent,
        });
        return reply.code(200).send({ plain_token: plainToken, signature });
      }

      // 2) 事件推送：验签（fail-closed）
      const timestampHeader = request.headers["x-signature-timestamp"];
      const signatureHeader = request.headers["x-signature-ed25519"];
      const verified = verifyWebhookSignature({
        publicKey: this.keyPair.publicKey,
        timestamp: Array.isArray(timestampHeader)
          ? timestampHeader[0]
          : timestampHeader,
        rawBody,
        signature: Array.isArray(signatureHeader)
          ? signatureHeader[0]
          : signatureHeader,
      });
      if (!verified) {
        log.warn("webhook request rejected: bad signature", {
          op: payload.op,
          eventType: payload.t,
        });
        return reply.code(401).send({ error: "invalid signature" });
      }

      // 3) 映射成内部事件并**先回 ACK、再串行处理**
      const eventType = typeof payload.t === "string" ? payload.t : "";
      const event =
        payload.op === 0 && eventType.length > 0
          ? this.mapper.map(eventType, payload.d)
          : null;
      if (event) {
        this.enqueue(event);
      } else {
        log.debug("webhook payload ignored", {
          op: payload.op,
          eventType,
        });
      }
      return reply.code(200).send({ op: 12, d: {} });
    });

    await server.listen({ port: this.port, host: this.host });
    this.server = server;
    log.info("webhook gateway listening", {
      host: this.host,
      port: this.port,
      path: this.path,
      seedSource: this.keyPair.seedSource,
      signContent: this.signContent,
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await server.close();
      log.info("webhook gateway stopped");
    }
    await this.flush();
  }

  /** 先回 ACK 再处理：按接收顺序串行，单个事件失败只记日志。 */
  private enqueue(event: QQEvent): void {
    this.queued += 1;
    const handler = this.handler;
    this.queue = this.queue
      .then(async () => {
        if (!handler) {
          return;
        }
        try {
          await handler(event);
        } catch (error) {
          log.error("webhook event handling failed", {
            type: event.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        this.queued -= 1;
      });
  }
}
