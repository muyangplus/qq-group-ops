import type { EventGateway, EventHandler } from "./eventGateway.js";
import type { QQOfficialAPI } from "./qqOfficial.js";
import { isRateLimitedError } from "./qqOfficial.js";
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

export interface QQOfficialGatewayReconnectPolicy {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterRatio: number;
  /** 命中限流时使用的固定冷却时间。 */
  rateLimitDelayMs: number;
  /** 连续失败多少次后认为缓存的网关地址已失效（仅在没有成功 open 过时计数）。 */
  invalidateGatewayAfterFailures: number;
}

export const DEFAULT_RECONNECT_POLICY: QQOfficialGatewayReconnectPolicy = {
  enabled: true,
  maxAttempts: 50,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  factor: 1.8,
  jitterRatio: 0.2,
  rateLimitDelayMs: 120_000,
  invalidateGatewayAfterFailures: 5,
};

export interface ReconnectInfo {
  attempt: number;
  delayMs: number;
  reason: string;
  rateLimited: boolean;
}

export interface QQOfficialGatewayOptions {
  api: QQOfficialAPI;
  createSocket: (url: string) => WebSocketLike;
  mapper: OfficialEventMapper;
  intents?: number;
  shard?: [number, number];
  properties?: Record<string, string>;
  scheduler?: Scheduler;
  reconnect?: Partial<QQOfficialGatewayReconnectPolicy>;
  random?: () => number;
  onHello?: (heartbeatIntervalMs: number) => void;
  onReady?: (sessionId: string) => void;
  onError?: (error: unknown) => void;
  onReconnect?: (info: ReconnectInfo) => void;
  onGroupMessageMode?: (groupId: string, enabled: boolean) => void;
}

export class QQOfficialGateway implements EventGateway {
  private readonly intents: number;
  private readonly shard: [number, number];
  private readonly properties: Record<string, string>;
  private readonly scheduler: Scheduler;
  private readonly reconnect: QQOfficialGatewayReconnectPolicy;
  private readonly random: () => number;
  private handler: EventHandler | undefined;
  private socket: WebSocketLike | undefined;
  private token = "";
  private heartbeatIntervalMs = 0;
  private heartbeatTimer: unknown;
  private reconnectTimer: unknown;
  private lastSequence: number | null = null;
  private sessionId: string | undefined;
  private stopped = false;
  private running = false;
  private attempts = 0;
  private reconnecting = false;
  private failuresSinceOpen = 0;
  private gatewayUrlInvalidated = false;

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
    this.reconnect = { ...DEFAULT_RECONNECT_POLICY, ...(options.reconnect ?? {}) };
    this.random = options.random ?? Math.random;
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get session(): string | undefined {
    return this.sessionId;
  }

  /** 首次连接失败会抛出，便于启动阶段快速暴露配置问题。 */
  public async start(handler: EventHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    this.attempts = 0;
    this.failuresSinceOpen = 0;
    this.gatewayUrlInvalidated = false;
    await this.connectOnce();
  }

  public async stop(): Promise<void> {
    log.info("stopping");
    this.stopped = true;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.reconnecting = false;
    this.socket?.close();
    this.socket = undefined;
    this.handler = undefined;
    this.running = false;
  }

  private async connectOnce(): Promise<void> {
    const gatewayUrl = await this.options.api.getGatewayUrl();
    this.token = await this.options.api.getAccessToken();
    log.debug("connecting", { gatewayUrl });
    const socket = this.options.createSocket(gatewayUrl);
    this.socket = socket;
    socket.on("open", () => {
      this.running = true;
      this.failuresSinceOpen = 0;
      log.debug("socket open");
    });
    socket.on("message", (payload) => {
      void this.handleMessage(payload);
    });
    socket.on("close", () => {
      this.handleDisconnect("close");
    });
    socket.on("error", (error) => {
      log.error("socket error", { error: formatError(error) });
      this.options.onError?.(error);
      this.handleDisconnect("error");
    });
  }

  private handleDisconnect(reason: "close" | "error"): void {
    const wasRunning = this.running;
    this.running = false;
    this.clearHeartbeat();
    if (this.stopped) {
      return;
    }
    this.failuresSinceOpen += 1;
    log.warn("socket disconnected", {
      reason,
      wasRunning,
      failures: this.failuresSinceOpen,
    });
    if (!this.reconnect.enabled || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    this.scheduleReconnect(reason, false);
  }

  private scheduleReconnect(reason: string, rateLimited: boolean): void {
    if (this.stopped) {
      this.reconnecting = false;
      return;
    }
    if (this.attempts >= this.reconnect.maxAttempts) {
      log.error("reconnect attempts exhausted, giving up", {
        attempts: this.attempts,
      });
      this.reconnecting = false;
      this.stopped = true;
      return;
    }
    this.attempts += 1;
    const delayMs = this.backoffDelay(rateLimited);
    log.info("scheduling reconnect", {
      attempt: this.attempts,
      delayMs,
      rateLimited,
      reason,
    });
    this.options.onReconnect?.({
      attempt: this.attempts,
      delayMs,
      reason,
      rateLimited,
    });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.runReconnect();
    }, delayMs);
  }

  private async runReconnect(): Promise<void> {
    if (this.stopped || !this.handler) {
      this.reconnecting = false;
      return;
    }
    try {
      await this.connectOnce();
      this.reconnecting = false;
    } catch (error) {
      const rateLimited = isRateLimitedError(error);
      this.failuresSinceOpen += 1;
      log.error("reconnect failed", {
        attempt: this.attempts,
        rateLimited,
        error: formatError(error),
      });
      this.options.onError?.(error);
      await this.maybeInvalidateGatewayUrl();
      if (rateLimited) {
        log.warn("gateway rate limited, using long cooldown", {
          cooldownMs: this.reconnect.rateLimitDelayMs,
        });
      }
      this.scheduleReconnect("retry", rateLimited);
    }
  }

  /**
   * 只有在「从未成功 open 过」且连续失败达到阈值时，才丢弃缓存的网关地址。
   * 这样既能在地址确实失效时恢复，又不会因为偶发网络抖动反复打 `/gateway`。
   */
  private async maybeInvalidateGatewayUrl(): Promise<void> {
    if (
      this.gatewayUrlInvalidated ||
      this.failuresSinceOpen < this.reconnect.invalidateGatewayAfterFailures
    ) {
      return;
    }
    this.gatewayUrlInvalidated = true;
    log.warn("invalidating cached gateway url after repeated failures", {
      failures: this.failuresSinceOpen,
    });
    await this.options.api.invalidateGatewayUrl?.().catch((error: unknown) => {
      log.warn("failed to invalidate gateway url", { error: formatError(error) });
    });
  }

  private backoffDelay(rateLimited: boolean): number {
    if (rateLimited) {
      return this.reconnect.rateLimitDelayMs;
    }
    const raw = Math.min(
      this.reconnect.maxDelayMs,
      this.reconnect.initialDelayMs *
        this.reconnect.factor ** Math.max(0, this.attempts - 1),
    );
    const jitter = raw * this.reconnect.jitterRatio * (this.random() * 2 - 1);
    return Math.max(0, Math.round(raw + jitter));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
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
      this.attempts = 0;
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
    if (raw.t === "GROUP_MSG_RECEIVE" || raw.t === "GROUP_MSG_REJECT") {
      const groupId = isRecord(data) ? asString(data.group_openid) : undefined;
      if (groupId) {
        const enabled = raw.t === "GROUP_MSG_RECEIVE";
        log.info(
          enabled
            ? "group message reception enabled"
            : "group message reception disabled",
          { groupId },
        );
        this.options.onGroupMessageMode?.(groupId, enabled);
      }
      return;
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
