import { getLogger } from "../core/logger.js";
import type { BotCacheSnapshot, BotCacheStore } from "./botCache.js";
import { PassiveReplyQuota } from "./passiveReplyQuota.js";
import {
  QQOfficialAPIError,
  isRateLimitedError,
  type QQOfficialAPIErrorOptions,
} from "./qqOfficialError.js";
import { SendThrottle } from "./sendThrottle.js";

export {
  QQOfficialAPIError,
  RATE_LIMIT_ERROR_CODES,
  isRateLimitedError,
} from "./qqOfficialError.js";
export type { QQOfficialAPIErrorOptions } from "./qqOfficialError.js";

const log = getLogger("qq-official-api");

export type JsonValue =
  | Record<string, unknown>
  | unknown[]
  | string
  | null
  | undefined;

export interface ApproveJoinRequestOptions {
  /** 拒绝理由（op=decline 时官方支持 reject_reason）。 */
  reason?: string | undefined;
  /** 入群申请 ID（join_request_id），官方推荐携带。 */
  joinRequestId?: string | undefined;
  /** op=decline 时是否同时加入群黑名单。 */
  addToMemberBlacklist?: boolean | undefined;
}

export interface QQOfficialAPI {
  getAccessToken(): Promise<string>;
  getGatewayUrl(): Promise<string>;
  invalidateGatewayUrl?(): Promise<void>;
  cacheStatus?(): Promise<{ tokenCached: boolean; gatewayUrlCached: boolean }>;
  sendGroupMessage(
    groupId: string,
    content: string,
    msgId?: string,
  ): Promise<Record<string, unknown>>;
  sendPrivateMessage(
    userOpenid: string,
    content: string,
    msgId?: string,
  ): Promise<Record<string, unknown>>;
  recallGroupMessage(groupId: string, messageId: string): Promise<void>;
  muteGroupMember(
    groupId: string,
    userId: string,
    durationSeconds: number,
  ): Promise<void>;
  removeGroupMember(groupId: string, userId: string): Promise<void>;
  approveJoinRequest(
    groupId: string,
    memberOpenid: string,
    approve: boolean,
    options?: ApproveJoinRequestOptions,
  ): Promise<void>;
  getJoinRequests(groupId: string): Promise<Record<string, unknown>[]>;
}

export interface HttpResponse {
  statusCode: number;
  jsonData?: unknown;
  text: string;
  headers?: Record<string, string>;
}

export interface AsyncTransport {
  request(
    method: string,
    url: string,
    headers: Record<string, string>,
    json?: JsonValue,
  ): Promise<HttpResponse>;
  aclose(): Promise<void>;
}

export interface QQOfficialEndpoints {
  baseUrl: string;
  tokenUrl: string;
  gatewayUrl: string;
  sendGroupMessage: string;
  sendPrivateMessage: string;
  recallGroupMessage: string;
  muteGroupMember: string;
  removeGroupMember: string;
  approveJoinRequest: string;
  joinRequestList: string;
}

export const DEFAULT_ENDPOINTS: QQOfficialEndpoints = {
  baseUrl: "https://api.sgroup.qq.com",
  tokenUrl: "https://bots.qq.com/app/getAppAccessToken",
  gatewayUrl: "/gateway",
  sendGroupMessage: "/v2/groups/{groupId}/messages",
  sendPrivateMessage: "/v2/users/{userOpenid}/messages",
  recallGroupMessage: "/v2/groups/{groupId}/messages/{messageId}",
  muteGroupMember: "/v2/groups/{groupId}/restrict_chat_setting",
  removeGroupMember: "/v2/groups/{groupId}/batch_remove_members",
  approveJoinRequest: "/v2/groups/{groupId}/approval_join_request/{memberOpenid}",
  joinRequestList: "/v2/groups/{groupId}/join_request_list",
};

export const DEFAULT_TOKEN_REFRESH_MARGIN_MS = 60_000;
export const DEFAULT_GATEWAY_COOLDOWN_MS = 60_000;
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 7_200;
/** 官方限制：单次禁言最长 30 天。 */
export const MAX_MUTE_DURATION_SECONDS = 30 * 24 * 60 * 60;
/** 入群申请列表最多翻页次数，避免异常游标导致死循环。 */
export const MAX_JOIN_REQUEST_PAGES = 5;

export interface QQOfficialClientOptions {
  token?: string;
  transport?: AsyncTransport;
  endpoints?: QQOfficialEndpoints;
  headers?: Record<string, string>;
  /** access token 与网关地址的持久化缓存。 */
  cacheStore?: BotCacheStore;
  /** 可注入时钟，便于测试。 */
  clock?: () => number;
  /** 提前多久认为 token 需要刷新，默认 60 秒。 */
  tokenRefreshMarginMs?: number;
  /** 命中限流后的冷却时间，默认 60 秒。 */
  rateLimitCooldownMs?: number;
  /** 出站消息节流器；传入 null 可关闭。 */
  sendThrottle?: SendThrottle | null;
  /** 被动回复配额；传入 null 可关闭拦截（默认开启）。 */
  passiveReplyQuota?: PassiveReplyQuota | null;
}

export class QQOfficialClient implements QQOfficialAPI {
  public readonly appId: string;
  private readonly clientSecret: string;
  private readonly transport: AsyncTransport | undefined;
  private readonly endpoints: QQOfficialEndpoints;
  private readonly extraHeaders: Record<string, string>;
  private readonly explicitToken: string;
  private readonly cacheStore: BotCacheStore | undefined;
  private readonly clock: () => number;
  private readonly tokenRefreshMarginMs: number;
  private readonly gatewayCooldownMs: number;
  private readonly sendThrottle: SendThrottle | undefined;
  private readonly passiveReplyQuota: PassiveReplyQuota | undefined;

  private tokenValue: string;
  private tokenExpiresAt: number | undefined;
  private inflightToken: Promise<string> | undefined;
  private gatewayUrlValue: string | undefined;
  private gatewayCooldownUntil = 0;
  private cache: BotCacheSnapshot | undefined;
  private cacheLoaded = false;

  public constructor(
    appId: string,
    clientSecret: string,
    options: QQOfficialClientOptions = {},
  ) {
    if (!appId || !clientSecret) {
      throw new Error("QQ_BOT_APP_ID and QQ_BOT_CLIENT_SECRET are required");
    }
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.transport = options.transport;
    this.endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
    this.extraHeaders = { ...(options.headers ?? {}) };
    this.explicitToken = options.token ?? "";
    this.tokenValue = this.explicitToken;
    this.cacheStore = options.cacheStore;
    this.clock = options.clock ?? Date.now;
    this.tokenRefreshMarginMs =
      options.tokenRefreshMarginMs ?? DEFAULT_TOKEN_REFRESH_MARGIN_MS;
    this.gatewayCooldownMs =
      options.rateLimitCooldownMs ?? DEFAULT_GATEWAY_COOLDOWN_MS;
    this.sendThrottle =
      options.sendThrottle === null
        ? undefined
        : (options.sendThrottle ??
          new SendThrottle({ isRateLimited: isRateLimitedError }));
    this.passiveReplyQuota =
      options.passiveReplyQuota === null
        ? undefined
        : (options.passiveReplyQuota ?? new PassiveReplyQuota());
  }

  public get token(): string {
    return this.tokenValue;
  }

  public async close(): Promise<void> {
    await this.transport?.aclose();
  }

  /** 当前缓存状态，用于启动日志与诊断。 */
  public async cacheStatus(): Promise<{
    tokenCached: boolean;
    gatewayUrlCached: boolean;
  }> {
    const cache = await this.loadCache();
    return {
      tokenCached: Boolean(cache.accessToken),
      gatewayUrlCached: Boolean(cache.gatewayUrl),
    };
  }

  public async ensureToken(): Promise<string> {
    if (this.tokenValue && !this.needsRefresh()) {
      return this.tokenValue;
    }
    if (this.inflightToken) {
      return this.inflightToken;
    }
    const pending = this.resolveToken().finally(() => {
      this.inflightToken = undefined;
    });
    this.inflightToken = pending;
    return pending;
  }

  public async getAccessToken(): Promise<string> {
    return this.ensureToken();
  }

  /**
   * 获取 WebSocket 网关地址。
   *
   * 官方 `/gateway` 接口限频非常严格，因此这里优先使用内存缓存和磁盘缓存，
   * 仅在两者都缺失时才真正请求；命中限流会进入冷却，避免重连风暴继续打接口。
   */
  public async getGatewayUrl(): Promise<string> {
    if (this.gatewayUrlValue) {
      return this.gatewayUrlValue;
    }
    const now = this.clock();
    if (now < this.gatewayCooldownUntil) {
      throw new QQOfficialAPIError(
        400,
        `gateway request cooling down for ${this.gatewayCooldownUntil - now}ms`,
        { err_code: 100017, retry_after_ms: this.gatewayCooldownUntil - now },
        {
          errorCode: 100017,
          retryAfterMs: this.gatewayCooldownUntil - now,
        },
      );
    }

    const cache = await this.loadCache();
    if (cache.gatewayUrl) {
      this.gatewayUrlValue = cache.gatewayUrl;
      log.info("gateway url reused from cache", { url: cache.gatewayUrl });
      return cache.gatewayUrl;
    }

    try {
      const response = await this.request("GET", this.endpoints.gatewayUrl);
      const data = isRecord(response.jsonData) ? response.jsonData : {};
      const url = data.url;
      if (typeof url !== "string" || url.length === 0) {
        throw new QQOfficialAPIError(
          response.statusCode,
          "gateway url missing",
          data,
        );
      }
      this.gatewayUrlValue = url;
      cache.gatewayUrl = url;
      await this.persistCache(cache);
      log.info("gateway url received", { url });
      return url;
    } catch (error) {
      if (isRateLimitedError(error)) {
        const cooldown = Math.max(
          this.gatewayCooldownMs,
          error instanceof QQOfficialAPIError
            ? (error.retryAfterMs ?? 0)
            : 0,
        );
        this.gatewayCooldownUntil = this.clock() + cooldown;
        log.warn("gateway request rate limited, cooling down", { cooldownMs: cooldown });
      }
      throw error;
    }
  }

  /** 丢弃缓存的网关地址；仅在确认地址失效时调用，避免触发 `/gateway` 限流。 */
  public async invalidateGatewayUrl(): Promise<void> {
    this.gatewayUrlValue = undefined;
    const cache = await this.loadCache();
    delete cache.gatewayUrl;
    await this.persistCache(cache);
    log.warn("gateway url cache invalidated");
  }

  public async sendGroupMessage(
    groupId: string,
    content: string,
    msgId?: string,
  ): Promise<Record<string, unknown>> {
    this.assertPassiveReplyAllowed(msgId);
    const payload: Record<string, unknown> = { content };
    if (msgId) {
      payload.msg_id = msgId;
    }
    const response = await this.throttled(`group:${groupId}`, () =>
      this.request("POST", fill(this.endpoints.sendGroupMessage, { groupId }), payload),
    );
    this.recordPassiveReply(msgId);
    return isRecord(response.jsonData) ? response.jsonData : {};
  }

  public async sendPrivateMessage(
    userOpenid: string,
    content: string,
    msgId?: string,
  ): Promise<Record<string, unknown>> {
    this.assertPassiveReplyAllowed(msgId);
    const payload: Record<string, unknown> = { msg_type: 0, content };
    if (msgId) {
      payload.msg_id = msgId;
    }
    const response = await this.throttled(`user:${userOpenid}`, () =>
      this.request(
        "POST",
        fill(this.endpoints.sendPrivateMessage, { userOpenid }),
        payload,
      ),
    );
    this.recordPassiveReply(msgId);
    return isRecord(response.jsonData) ? response.jsonData : {};
  }

  /**
   * 被动回复配额检查。
   *
   * 单聊同一 msg_id 最多回复 5 次、群聊被动回复 5 分钟有效；超限继续发会失败（22009），
   * 这里直接拒绝并抛出可识别的错误，由调用方决定降级策略。
   */
  private assertPassiveReplyAllowed(msgId: string | undefined): void {
    if (!msgId || !this.passiveReplyQuota) {
      return;
    }
    const decision = this.passiveReplyQuota.check(msgId);
    if (decision.allowed) {
      return;
    }
    log.warn("passive reply quota exhausted", {
      msgId,
      reason: decision.reason,
      used: decision.used,
    });
    throw new QQOfficialAPIError(
      400,
      `passive reply quota exhausted (${decision.reason})`,
      { err_code: 22009, reason: decision.reason, used: decision.used },
      { errorCode: 22009 },
    );
  }

  private recordPassiveReply(msgId: string | undefined): void {
    if (msgId && this.passiveReplyQuota) {
      this.passiveReplyQuota.record(msgId);
    }
  }

  public async recallGroupMessage(groupId: string, messageId: string): Promise<void> {
    await this.request(
      "DELETE",
      fill(this.endpoints.recallGroupMessage, { groupId, messageId }),
    );
  }

  /**
   * 设置群成员禁言（官方 `POST /v2/groups/{group_openid}/restrict_chat_setting`）。
   *
   * 请求体：`{ members: [{ op, member_openid, mute_expire_at }] }`，
   * `op` 取 `add` / `update` / `del`，`mute_expire_at` 为 RFC3339 到期时间；
   * `durationSeconds <= 0` 时使用 `op=del` + 空字符串表示立即解除禁言。
   * 官方限制最长 30 天、单次最多 20 个成员，且机器人需为群管理员。
   */
  public async muteGroupMember(
    groupId: string,
    userId: string,
    durationSeconds: number,
  ): Promise<void> {
    const seconds = Math.min(
      Math.max(0, Math.floor(durationSeconds)),
      MAX_MUTE_DURATION_SECONDS,
    );
    const member =
      seconds <= 0
        ? { op: "del", member_openid: userId, mute_expire_at: "" }
        : {
            op: "add",
            member_openid: userId,
            mute_expire_at: new Date(
              this.clock() + seconds * 1_000,
            ).toISOString(),
          };
    await this.request(
      "POST",
      fill(this.endpoints.muteGroupMember, { groupId }),
      { members: [member] },
    );
  }

  /**
   * 批量移除群成员（官方 `POST /v2/groups/{group_openid}/batch_remove_members`）。
   *
   * 注意：该接口仅白名单机器人可用，未开通时会返回错误码 11253。
   */
  public async removeGroupMember(
    groupId: string,
    userId: string,
  ): Promise<void> {
    await this.request(
      "POST",
      fill(this.endpoints.removeGroupMember, { groupId }),
      { member_openids: [userId] },
    );
  }

  /**
   * 审批入群申请（官方 `POST /v2/groups/{group_openid}/approval_join_request/{member_openid}`）。
   *
   * 请求体：`{ op: "approve" | "decline", join_request_id?, reject_reason?, add_to_member_blacklist? }`。
   */
  public async approveJoinRequest(
    groupId: string,
    memberOpenid: string,
    approve: boolean,
    options: ApproveJoinRequestOptions = {},
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      op: approve ? "approve" : "decline",
    };
    if (options.joinRequestId) {
      payload.join_request_id = options.joinRequestId;
    }
    if (!approve && options.reason) {
      payload.reject_reason = options.reason;
    }
    if (options.addToMemberBlacklist !== undefined) {
      payload.add_to_member_blacklist = options.addToMemberBlacklist;
    }
    await this.request(
      "POST",
      fill(this.endpoints.approveJoinRequest, { groupId, memberOpenid }),
      payload,
    );
  }

  /**
   * 拉取入群申请列表（官方返回 `{ list, next_cursor }`），自动跟随游标翻页。
   */
  public async getJoinRequests(groupId: string): Promise<Record<string, unknown>[]> {
    const requests: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_JOIN_REQUEST_PAGES; page += 1) {
      const path = fill(this.endpoints.joinRequestList, { groupId });
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await this.request("GET", `${path}${query}`);
      const pageResult = extractJoinRequestPage(response.jsonData);
      requests.push(...pageResult.requests);
      if (!pageResult.nextCursor) {
        break;
      }
      cursor = pageResult.nextCursor;
    }
    return requests;
  }

  private async resolveToken(): Promise<string> {
    if (this.tokenValue && !this.needsRefresh()) {
      return this.tokenValue;
    }
    if (!this.transport) {
      throw new Error("transport is required to fetch access token");
    }

    const cache = await this.loadCache();
    const cachedToken = cache.accessToken;
    const cachedExpiresAt = cache.accessTokenExpiresAt;
    if (
      cachedToken &&
      cachedExpiresAt !== undefined &&
      cachedExpiresAt - this.tokenRefreshMarginMs > this.clock()
    ) {
      this.tokenValue = cachedToken;
      this.tokenExpiresAt = cachedExpiresAt;
      log.info("access token reused from cache", {
        expiresInMs: cachedExpiresAt - this.clock(),
      });
      return cachedToken;
    }

    log.debug("requesting access token");
    const response = await this.transport.request(
      "POST",
      this.endpoints.tokenUrl,
      { "Content-Type": "application/json", ...this.extraHeaders },
      { appId: this.appId, clientSecret: this.clientSecret },
    );
    raiseForStatus(response);
    const data = isRecord(response.jsonData) ? response.jsonData : {};
    const token = data.access_token ?? data.accessToken;
    if (typeof token !== "string" || token.length === 0) {
      throw new QQOfficialAPIError(
        response.statusCode,
        "access_token missing",
        data,
      );
    }
    const expiresInSeconds = parseExpiresIn(data.expires_in);
    const now = this.clock();
    this.tokenValue = token;
    this.tokenExpiresAt = now + expiresInSeconds * 1_000;
    cache.accessToken = token;
    cache.accessTokenExpiresAt = this.tokenExpiresAt;
    await this.persistCache(cache);
    log.info("access token acquired", { expiresInSeconds });
    return token;
  }

  private needsRefresh(): boolean {
    if (this.explicitToken) {
      return false;
    }
    if (this.tokenExpiresAt === undefined) {
      return false;
    }
    return this.tokenExpiresAt - this.tokenRefreshMarginMs <= this.clock();
  }

  private async invalidateToken(): Promise<void> {
    this.tokenValue = "";
    this.tokenExpiresAt = undefined;
    this.inflightToken = undefined;
    const cache = await this.loadCache();
    delete cache.accessToken;
    delete cache.accessTokenExpiresAt;
    await this.persistCache(cache);
  }

  /** 显式配置了 QQ_BOT_TOKEN 时不自动刷新，交由运维处理。 */
  private canRefreshToken(): boolean {
    return this.explicitToken.length === 0;
  }

  private async throttled(
    label: string,
    task: () => Promise<HttpResponse>,
  ): Promise<HttpResponse> {
    if (!this.sendThrottle) {
      return task();
    }
    return this.sendThrottle.run(label, task);
  }

  private async request(
    method: string,
    path: string,
    json?: JsonValue,
  ): Promise<HttpResponse> {
    try {
      return await this.performRequest(method, path, json);
    } catch (error) {
      if (this.canRefreshToken() && isUnauthorized(error)) {
        log.warn("access token rejected by server, refreshing and retrying", {
          path,
        });
        await this.invalidateToken();
        return this.performRequest(method, path, json);
      }
      throw error;
    }
  }

  private async performRequest(
    method: string,
    path: string,
    json?: JsonValue,
  ): Promise<HttpResponse> {
    await this.ensureToken();
    if (!this.transport) {
      throw new Error("transport is required");
    }
    const url = `${this.endpoints.baseUrl.replace(/\/$/u, "")}${path}`;
    const response = await this.transport.request(
      method,
      url,
      this.headers(),
      json,
    );
    raiseForStatus(response);
    return response;
  }

  private headers(): Record<string, string> {
    // 官方文档要求需要核实：Authorization 与 X-Union-Appid。
    return {
      Authorization: `QQBot ${this.tokenValue}`,
      "Content-Type": "application/json",
      "X-Union-Appid": this.appId,
      ...this.extraHeaders,
    };
  }

  private async loadCache(): Promise<BotCacheSnapshot> {
    if (!this.cacheLoaded) {
      this.cacheLoaded = true;
      const loaded = await this.cacheStore?.load(this.appId).catch((error: unknown) => {
        log.warn("failed to load bot cache", { error: formatError(error) });
        return null;
      });
      this.cache = loaded ? { ...loaded, appId: this.appId } : { appId: this.appId };
    }
    return this.cache ?? { appId: this.appId };
  }

  private async persistCache(snapshot: BotCacheSnapshot): Promise<void> {
    if (!this.cacheStore) {
      return;
    }
    try {
      await this.cacheStore.save(snapshot);
    } catch (error) {
      log.warn("failed to persist bot cache", { error: formatError(error) });
    }
  }
}

function parseExpiresIn(value: unknown): number {  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TOKEN_LIFETIME_SECONDS;
  }
  // 太短会导致频繁刷新，按最小值兜底。
  return Math.max(60, Math.floor(parsed));
}

export interface JoinRequestPage {
  requests: Record<string, unknown>[];
  nextCursor: string | undefined;
}

/** 兼容 `{ list, next_cursor }`、`{ data }` 与裸数组三种返回形态。 */
export function extractJoinRequestPage(payload: unknown): JoinRequestPage {
  if (Array.isArray(payload)) {
    return { requests: payload.filter(isRecord), nextCursor: undefined };
  }
  if (!isRecord(payload)) {
    return { requests: [], nextCursor: undefined };
  }
  const rawList = Array.isArray(payload.list)
    ? payload.list
    : Array.isArray(payload.data)
      ? payload.data
      : [];
  const nextCursor =
    typeof payload.next_cursor === "string" && payload.next_cursor.length > 0
      ? payload.next_cursor
      : undefined;
  return { requests: rawList.filter(isRecord), nextCursor };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`missing endpoint parameter: ${key}`);
    }
    return encodeURIComponent(value);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof QQOfficialAPIError && error.statusCode === 401;
}

function raiseForStatus(response: HttpResponse): void {
  if (response.statusCode < 400) {
    return;
  }
  const payload = response.jsonData ?? response.text;
  const message = isRecord(payload)
    ? String(payload.message ?? payload.msg ?? JSON.stringify(payload))
    : String(payload);
  throw new QQOfficialAPIError(response.statusCode, message, payload, {
    errorCode: extractErrorCode(payload),
    retryAfterMs: extractRetryAfterMs(response, payload),
  });
}

function extractErrorCode(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  for (const key of ["err_code", "errcode", "code"]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/u.test(value)) {
      return Number.parseInt(value, 10);
    }
  }
  const nested = payload.data;
  if (nested !== undefined && nested !== payload) {
    return extractErrorCode(nested);
  }
  return undefined;
}

function extractRetryAfterMs(
  response: HttpResponse,
  payload: unknown,
): number | undefined {
  const header = response.headers?.["retry-after"];
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1_000);
    }
  }
  if (isRecord(payload)) {
    const value = payload.retry_after ?? payload.retryAfter;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.round(value * 1_000);
    }
  }
  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
