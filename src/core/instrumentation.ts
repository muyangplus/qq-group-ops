import type { EventGateway, EventHandler } from "../adapters/eventGateway.js";
import type {
  ApproveJoinRequestOptions,
  AsyncTransport,
  HttpResponse,
  JsonValue,
  QQOfficialAPI,
  RawBody,
  RemoveGroupMemberOptions,
  RichMessageOptions,
} from "../adapters/qqOfficial.js";
import type { Queryable, QueryResult } from "../db/queryable.js";
import type { Logger } from "./logger.js";

type QQOfficialMethod =
  | "getAccessToken"
  | "getGatewayUrl"
  | "sendGroupMessage"
  | "sendPrivateMessage"
  | "recallGroupMessage"
  | "muteGroupMember"
  | "removeGroupMember"
  | "updateMemberBlacklist"
  | "respondInteraction"
  | "approveJoinRequest"
  | "getJoinRequests"
  | "uploadGroupImage"
  | "sendGroupImage";

export function instrumentQQOfficialAPI(
  api: QQOfficialAPI,
  logger: Logger,
): QQOfficialAPI {
  const log = logger.child("qq-official-api");
  const overrides: Record<QQOfficialMethod, (...args: never[]) => Promise<unknown>> = {
    getAccessToken: async () => {
      log.debug("getAccessToken");
      const token = await api.getAccessToken();
      log.debug("getAccessToken ok", { tokenLength: token.length });
      return token;
    },
    getGatewayUrl: async () => {
      log.debug("getGatewayUrl");
      const url = await api.getGatewayUrl();
      log.info("gateway url received", { url });
      return url;
    },
    sendGroupMessage: async (
      groupId: string,
      content: string,
      msgId?: string,
      options?: RichMessageOptions,
    ) => {
      log.debug("sendGroupMessage", {
        groupId,
        msgId,
        contentLength: content.length,
        ...richLogFields(options),
      });
      const result = await api.sendGroupMessage(groupId, content, msgId, options);
      log.debug("sendGroupMessage ok", {
        groupId,
        messageId: typeof result.id === "string" ? result.id : undefined,
      });
      return result;
    },
    sendPrivateMessage: async (
      userOpenid: string,
      content: string,
      msgId?: string,
      options?: RichMessageOptions,
    ) => {
      log.debug("sendPrivateMessage", {
        userOpenid,
        msgId,
        contentLength: content.length,
        ...richLogFields(options),
      });
      const result = await api.sendPrivateMessage(
        userOpenid,
        content,
        msgId,
        options,
      );
      log.debug("sendPrivateMessage ok", {
        userOpenid,
        messageId: typeof result.id === "string" ? result.id : undefined,
      });
      return result;
    },
    recallGroupMessage: async (groupId: string, messageId: string) => {
      log.debug("recallGroupMessage", { groupId, messageId });
      await api.recallGroupMessage(groupId, messageId);
      log.debug("recallGroupMessage ok", { groupId, messageId });
    },
    muteGroupMember: async (
      groupId: string,
      userId: string,
      durationSeconds: number,
    ) => {
      log.debug("muteGroupMember", { groupId, userId, durationSeconds });
      await api.muteGroupMember(groupId, userId, durationSeconds);
      log.debug("muteGroupMember ok", { groupId, userId });
    },
    removeGroupMember: async (
      groupId: string,
      userId: string,
      options: RemoveGroupMemberOptions = {},
    ) => {
      log.debug("removeGroupMember", {
        groupId,
        userId,
        addToMemberBlacklist: options.addToMemberBlacklist ?? false,
      });
      await api.removeGroupMember(groupId, userId, options);
      log.debug("removeGroupMember ok", { groupId, userId });
    },
    updateMemberBlacklist: async (
      groupId: string,
      userId: string,
      add: boolean,
    ) => {
      log.debug("updateMemberBlacklist", { groupId, userId, add });
      await api.updateMemberBlacklist(groupId, userId, add);
      log.debug("updateMemberBlacklist ok", { groupId, userId, add });
    },
    respondInteraction: async (interactionId: string, code = 0) => {
      log.debug("respondInteraction", { interactionId, code });
      await api.respondInteraction(interactionId, code);
      log.debug("respondInteraction ok", { interactionId, code });
    },
    approveJoinRequest: async (
      groupId: string,
      memberOpenid: string,
      approve: boolean,
      options: ApproveJoinRequestOptions = {},
    ) => {
      log.debug("approveJoinRequest", {
        groupId,
        memberOpenid,
        approve,
        hasReason: Boolean(options.reason),
        hasJoinRequestId: Boolean(options.joinRequestId),
      });
      await api.approveJoinRequest(groupId, memberOpenid, approve, options);
      log.debug("approveJoinRequest ok", { groupId, memberOpenid, approve });
    },
    getJoinRequests: async (groupId: string) => {
      log.debug("getJoinRequests", { groupId });
      const requests = await api.getJoinRequests(groupId);
      log.debug("getJoinRequests ok", { groupId, count: requests.length });
      return requests;
    },
    uploadGroupImage: async (
      groupId: string,
      fileName: string,
      data: Uint8Array,
    ) => {
      log.debug("uploadGroupImage", {
        groupId,
        fileName,
        bytes: data.byteLength,
      });
      const result = await api.uploadGroupImage(groupId, fileName, data);
      log.debug("uploadGroupImage ok", {
        groupId,
        bytes: data.byteLength,
        hasFileInfo: typeof result.file_info === "string",
      });
      return result;
    },
    sendGroupImage: async (groupId: string, fileInfo: string, msgId?: string) => {
      log.debug("sendGroupImage", {
        groupId,
        msgId,
        fileInfoLength: fileInfo.length,
      });
      const result = await api.sendGroupImage(groupId, fileInfo, msgId);
      log.debug("sendGroupImage ok", {
        groupId,
        messageId: typeof result.id === "string" ? result.id : undefined,
      });
      return result;
    },
  };

  return new Proxy(api, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) {
        return overrides[property as QQOfficialMethod];
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as QQOfficialAPI;
}

export function instrumentTransport(
  transport: AsyncTransport,
  logger: Logger,
): AsyncTransport {
  const log = logger.child("http");
  return {
    async request(
      method: string,
      url: string,
      headers: Record<string, string>,
      json?: JsonValue,
    ): Promise<HttpResponse> {
      const startedAt = Date.now();
      log.debug("request", { method, url, hasJson: json !== undefined });
      try {
        const response = await transport.request(method, url, headers, json);
        log.debug("response", {
          method,
          url,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        log.error("request failed", {
          method,
          url,
          durationMs: Date.now() - startedAt,
          error: formatError(error),
        });
        throw error;
      }
    },
    async requestRaw(
      method: string,
      url: string,
      headers: Record<string, string>,
      body: RawBody,
    ): Promise<HttpResponse> {
      const startedAt = Date.now();
      log.debug("request raw", {
        method,
        url,
        bytes: body.body.byteLength,
        contentType: body.contentType,
      });
      try {
        if (!transport.requestRaw) {
          throw new Error("transport does not support raw uploads");
        }
        const response = await transport.requestRaw(method, url, headers, body);
        log.debug("request raw response", {
          method,
          url,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        log.error("request raw failed", {
          method,
          url,
          durationMs: Date.now() - startedAt,
          error: formatError(error),
        });
        throw error;
      }
    },
    async aclose(): Promise<void> {
      await transport.aclose();
    },
  };
}

export function instrumentQueryable(db: Queryable, logger: Logger): Queryable {
  const log = logger.child("db");
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      const startedAt = Date.now();
      const sql = summarizeSql(text);
      log.debug("query", { sql, params: values?.length ?? 0 });
      try {
        const result = await db.query<Row>(text, values);
        log.debug("query ok", {
          sql,
          rows: result.rows.length,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        log.error("query failed", {
          sql,
          durationMs: Date.now() - startedAt,
          error: formatError(error),
        });
        throw error;
      }
    },
  };
}

export function instrumentEventGateway(
  gateway: EventGateway,
  logger: Logger,
): EventGateway {
  const log = logger.child("event-gateway");
  return {
    async start(handler: EventHandler): Promise<void> {
      log.info("starting");
      await gateway.start(async (event) => {
        log.debug("event", {
          type: event.type,
          userId: event.userId,
          ...("groupId" in event ? { groupId: event.groupId } : {}),
        });
        await handler(event);
      });
      log.info("started");
    },
    async stop(): Promise<void> {
      log.info("stopping");
      await gateway.stop();
      log.info("stopped");
    },
  };
}

function summarizeSql(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}

function richLogFields(options: RichMessageOptions | undefined): {
  markdown?: boolean;
  keyboard?: boolean;
} {
  if (!options?.markdown) {
    return {};
  }
  return {
    markdown: true,
    keyboard: options.keyboard !== undefined,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
