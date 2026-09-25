import { getLogger } from "../core/logger.js";
import type {
  BotCacheSnapshot,
  BotCacheStore,
} from "./botCache.js";
import { PassiveReplyQuota } from "./passiveReplyQuota.js";
import {
  QQOfficialAPIError,
  isRateLimitedError,
} from "./qqOfficialError.js";
import {
  type PreparedUpload,
  buildGroupImagePayload,
  extractFileInfo,
  parsePreparedUpload,
  extractJoinRequestPage,
  fill,
  buildMessagePayload,
  isRecord,
  isUnauthorized,
  raiseForStatus,
  formatError,
} from "./qqOfficialPayload.js";
import {
  type JsonValue,
  type RemoveGroupMemberOptions,
  type ApproveJoinRequestOptions,
  type RichMessageOptions,
  type QQOfficialAPI,
  type HttpResponse,
  type AsyncTransport,
  type QQOfficialEndpoints,
  DEFAULT_ENDPOINTS,
  DEFAULT_TOKEN_REFRESH_MARGIN_MS,
  DEFAULT_GATEWAY_COOLDOWN_MS,
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  MAX_MUTE_DURATION_SECONDS,
  MAX_JOIN_REQUEST_PAGES,
  GROUP_FILE_TYPE_IMAGE,
  type QQOfficialClientOptions,
} from "./qqOfficialTypes.js";
import { SendThrottle } from "./sendThrottle.js";

/**
 * QQ 官方 API 客户端：token 与网关地址管理、消息发送、群成员管理、互动回调、媒体上传。
 */

const log = getLogger("qq-official-api");

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
    options?: RichMessageOptions,
  ): Promise<Record<string, unknown>> {
    this.assertPassiveReplyAllowed(msgId);
    const payload = buildMessagePayload(content, msgId, options);
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
    options?: RichMessageOptions,
  ): Promise<Record<string, unknown>> {
    this.assertPassiveReplyAllowed(msgId);
    const payload = buildMessagePayload(content, msgId, options, true);
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
   * 传入 `addToMemberBlacklist` 可以在同一次调用里完成移出 + 拉黑。
   */
  public async removeGroupMember(
    groupId: string,
    userId: string,
    options: RemoveGroupMemberOptions = {},
  ): Promise<void> {
    const payload: Record<string, unknown> = { member_openids: [userId] };
    if (options.addToMemberBlacklist !== undefined) {
      payload.add_to_member_blacklist = options.addToMemberBlacklist;
    }
    await this.request(
      "POST",
      fill(this.endpoints.removeGroupMember, { groupId }),
      payload,
    );
  }

  /**
   * 群黑名单操作（官方 `POST /v2/groups/{group_openid}/member_blacklist`）。
   *
   * 官方要求加入黑名单时目标不在群中；该接口同样仅白名单机器人可用。
   */
  public async updateMemberBlacklist(
    groupId: string,
    userId: string,
    add: boolean,
  ): Promise<void> {
    await this.request(
      "POST",
      fill(this.endpoints.memberBlacklist, { groupId }),
      { op: add ? "add" : "del", member_openids: [userId] },
    );
  }

  /**
   * 回应互动事件（官方 `PUT /interactions/{interaction_id}`）。
   *
   * 请求体只有 `{ code }`：0=成功、1=操作失败、2=操作频繁、3=重复操作、4=没有权限、
   * 5=仅管理员操作。官方**没有更新原消息的接口**，回调只能让机器人被动回复新消息。
   */
  public async respondInteraction(
    interactionId: string,
    code = 0,
  ): Promise<void> {
    await this.request(
      "PUT",
      fill(this.endpoints.interaction, { interactionId }),
      { code },
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

  /**
   * 上传一张图片到群聊（官方文档「群聊富媒体上传」）。
   *
   * 官方只提供两种上传方式：`url` 直传（平台去下载）与分片上传合并。
   * 本地渲染出来的 PNG 没有公网 URL，因此这里走分片：
   *
   * 1. `POST /v2/groups/{group_openid}/upload_prepare` 拿 `upload_id` + 分片预签名 URL；
   * 2. 按 `block_size` 切片，逐片 `PUT` 到预签名 URL；
   * 3. 每片成功后 `POST /v2/groups/{group_openid}/upload_part_finish` 通知服务端；
   * 4. `POST /v2/groups/{group_openid}/files` 带 `upload_id` 合并，返回 `{ file_info }`。
   *
   * 任意一步失败都抛错（调用方按「拿不到富媒体能力」降级，不会让启动失败）。
   */
  public async uploadGroupImage(
    groupId: string,
    fileName: string,
    data: Uint8Array,
  ): Promise<Record<string, unknown>> {
    if (data.byteLength === 0) {
      throw new Error("uploadGroupImage requires non-empty data");
    }
    const prepared = await this.prepareGroupFileUpload(groupId, data.byteLength);
    for (
      let index = 0;
      index < Math.ceil(data.byteLength / prepared.blockSize);
      index += 1
    ) {
      const offset = index * prepared.blockSize;
      const chunk = data.subarray(
        offset,
        Math.min(offset + prepared.blockSize, data.byteLength),
      );
      const url = prepared.urls[index];
      if (!url) {
        throw new Error(
          `upload_prepare returned ${prepared.urls.length} urls, need ${Math.ceil(data.byteLength / prepared.blockSize)}`,
        );
      }
      const response = await this.putRaw(url, chunk);
      await this.request(
        "POST",
        fill(this.endpoints.groupFileUploadPartFinish, { groupId }),
        {
          upload_id: prepared.uploadId,
          block_index: index,
          block_size: chunk.byteLength,
          ...(response.headers?.etag ? { md5: response.headers.etag } : {}),
        },
      );
    }
    const response = await this.request(
      "POST",
      fill(this.endpoints.groupFileUpload, { groupId }),
      {
        file_type: GROUP_FILE_TYPE_IMAGE,
        srv_send_msg: false,
        file_name: fileName,
        upload_id: prepared.uploadId,
      },
    );
    return extractFileInfo(response.jsonData);
  }

  /**
   * 发送一张已上传的群图片（官方 `msg_type=7` 富媒体消息）。
   *
   * 请求体 `{ msg_type: 7, media: { file_info } }`；`file_info` 由 `uploadGroupImage`
   * 返回，官方要求**原样透传**（内部是序列化二进制）。带 `msgId` 时按被动回复发送。
   */
  public async sendGroupImage(
    groupId: string,
    fileInfo: string,
    msgId?: string,
  ): Promise<Record<string, unknown>> {
    if (!fileInfo) {
      throw new Error("sendGroupImage requires file_info");
    }
    this.assertPassiveReplyAllowed(msgId);
    const response = await this.throttled(`group:${groupId}`, () =>
      this.request(
        "POST",
        fill(this.endpoints.sendGroupMessage, { groupId }),
        buildGroupImagePayload(fileInfo, msgId),
      ),
    );
    this.recordPassiveReply(msgId);
    return isRecord(response.jsonData) ? response.jsonData : {};
  }

  /** 官方「群聊富媒体预上传」：拿 `upload_id`、分片大小与各片预签名 URL。 */
  private async prepareGroupFileUpload(
    groupId: string,
    size: number,
  ): Promise<PreparedUpload> {
    const response = await this.request(
      "POST",
      fill(this.endpoints.groupFileUploadPrepare, { groupId }),
      {
        file_type: GROUP_FILE_TYPE_IMAGE,
        file_size: size,
        srv_send_msg: false,
      },
    );
    return parsePreparedUpload(response.jsonData, size);
  }

  /**
   * 把分片 `PUT` 到预签名 URL。
   *
   * 预签名 URL 自带签名，**不能**带机器人 `Authorization` 头；transport 未实现
   * `requestRaw` 时直接抛错，由调用方降级（不做任何伪成功）。
   */
  private async putRaw(url: string, body: Uint8Array): Promise<HttpResponse> {
    if (!this.transport?.requestRaw) {
      throw new Error("transport does not support raw uploads");
    }
    const response = await this.transport.requestRaw("PUT", url, {}, {
      contentType: "application/octet-stream",
      body,
    });
    raiseForStatus(response);
    return response;
  }

  private async resolveToken(): Promise<string> {    if (this.tokenValue && !this.needsRefresh()) {
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
