import type { EventGateway, EventHandler } from "./eventGateway.js";
import type { QQOfficialAPI } from "./qqOfficial.js";
import type { OfficialEventMapper } from "./qqOfficialEventMapper.js";
import type { WebSocketLike } from "./webSocketGateway.js";
import {
  SystemScheduler,
  type Scheduler,
} from "./reconnectingWebSocketGateway.js";
import { getLogger } from "../core/logger.js";

export const GROUP_MEMBER_EVENT = 1 << 24;
export const GROUP_AND_C2C_EVENT = 1 << 25;

const log = getLogger("qq-official-gateway");

export interface QQOfficialGatewayOptions {
  api: QQOfficialAPI;
  createSocket: (url: string) => WebSocketLike;
  mapper: OfficialEventMapper;
  intents?: number;
  shard?: [number, number];
  properties?: Record<string, string>;
  scheduler?: Scheduler;
  onHello?: (heartbeatIntervalMs: number) => void;
  onReady?: (sessionId: string) => void;
  onError?: (error: unknown) => void;
}

export class QQOfficialGateway implements EventGateway {
  private readonly intents: number;
  private readonly shard: [number, number];
  private readonly properties: Record<string, string>;
  private readonly scheduler: Scheduler;
  private handler: EventHandler | undefined;
  private socket: WebSocketLike | undefined;
  private token = "";
  private heartbeatIntervalMs = 0;
  private heartbeatTimer: unknown;
  private lastSequence: number | null = null;
  private sessionId: string | undefined;
  private stopped = false;
  private running = false;

  public constructor(private readonly options: QQOfficialGatewayOptions) {
    this.intents =
      options.intents ?? GROUP_MEMBER_EVENT | GROUP_AND_C2C_EVENT;
    this.shard = options.shard ?? [0, 1];
    this.properties = options.properties ?? {
      $os: "linux",
      $browser: "qq-group-ops",
      $device: "qq-group-ops",
    };
    this.scheduler = options.scheduler ?? new SystemScheduler();
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get session(): string | undefined {
    return this.sessionId;
  }

  public async start(handler: EventHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    const gatewayUrl = await this.options.api.getGatewayUrl();
    this.token = await this.options.api.getAccessToken();
    log.debug("connecting", { gatewayUrl });
    const socket = this.options.createSocket(gatewayUrl);
    this.socket = socket;
    socket.on("open", () => {
      this.running = true;
      log.debug("socket open");
    });
    socket.on("message", (payload) => {
      void this.handleMessage(payload);
    });
    socket.on("close", () => {
      this.running = false;
      this.clearHeartbeat();
      log.warn("socket closed");
    });
    socket.on("error", (error) => {
      this.running = false;
      this.clearHeartbeat();
      log.error("socket error", { error: formatError(error) });
      this.options.onError?.(error);
    });
  }

  public async stop(): Promise<void> {
    log.info("stopping");
    this.stopped = true;
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = undefined;
    this.handler = undefined;
    this.running = false;
  }

  private async handleMessage(payload: unknown): Promise<void> {
    if (this.stopped) {
      return;
    }
    const raw = typeof payload === "string" ? parseJson(payload) : payload;
    if (!isRecord(raw)) {
      return;
    }
    const op = raw.op;
    const data = raw.d;

    if (op === 10) {
      if (isRecord(data) && typeof data.heartbeat_interval === "number") {
        this.heartbeatIntervalMs = data.heartbeat_interval;
      }
      log.debug("hello", { heartbeatIntervalMs: this.heartbeatIntervalMs });
      this.options.onHello?.(this.heartbeatIntervalMs);
      this.sendIdentify();
      this.startHeartbeat();
      return;
    }

    if (op === 11) {
      return;
    }

    if (op !== 0) {
      return;
    }

    if (typeof raw.s === "number") {
      this.lastSequence = raw.s;
    }
    if (
      raw.t === "READY" &&
      isRecord(data) &&
      typeof data.session_id === "string"
    ) {
      this.sessionId = data.session_id;
      log.info("ready", { hasSession: Boolean(this.sessionId) });
      this.options.onReady?.(this.sessionId);
    }
    if (typeof raw.t !== "string") {
      return;
    }
    log.debug("dispatch", {
      eventType: raw.t,
      sequence: typeof raw.s === "number" ? raw.s : null,
    });
    if (raw.t === "GROUP_MSG_RECEIVE") {
      log.info("group message reception enabled", {
        groupId: isRecord(data) ? data.group_openid : undefined,
      });
    }
    const event = this.options.mapper.map(raw.t, data);
    if (event && this.handler) {
      await this.handler(event);
    }
  }

  private sendIdentify(): void {
    log.debug("identify", { intents: this.intents, shard: this.shard });
    this.send({
      op: 2,
      d: {
        token: `QQBot ${this.token}`,
        intents: this.intents,
        shard: this.shard,
        properties: this.properties,
      },
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    if (this.stopped || this.heartbeatIntervalMs <= 0) {
      return;
    }
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      this.heartbeatTimer = undefined;
      this.sendHeartbeat();
      this.startHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeat(): void {
    log.debug("heartbeat", { seq: this.lastSequence });
    this.send({ op: 1, d: this.lastSequence });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      this.scheduler.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private send(payload: unknown): void {
    if (this.stopped || !this.socket) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
