import type { EventGateway, EventHandler } from "../adapters/eventGateway.js";
import type {
  AsyncTransport,
  HttpResponse,
  JsonValue,
  QQOfficialAPI,
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
  | "approveJoinRequest"
  | "getJoinRequests";

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
    sendGroupMessage: async (groupId: string, content: string, msgId?: string) => {
      log.debug("sendGroupMessage", {
        groupId,
        msgId,
        contentLength: content.length,
      });
      const result = await api.sendGroupMessage(groupId, content, msgId);
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
    ) => {
      log.debug("sendPrivateMessage", {
        userOpenid,
        msgId,
        contentLength: content.length,
      });
      const result = await api.sendPrivateMessage(userOpenid, content, msgId);
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
    removeGroupMember: async (groupId: string, userId: string) => {
      log.debug("removeGroupMember", { groupId, userId });
      await api.removeGroupMember(groupId, userId);
      log.debug("removeGroupMember ok", { groupId, userId });
    },
    approveJoinRequest: async (
      groupId: string,
      memberOpenid: string,
      approve: boolean,
      reason = "",
    ) => {
      log.debug("approveJoinRequest", { groupId, memberOpenid, approve, reason });
      await api.approveJoinRequest(groupId, memberOpenid, approve, reason);
      log.debug("approveJoinRequest ok", { groupId, memberOpenid, approve });
    },
    getJoinRequests: async (groupId: string) => {
      log.debug("getJoinRequests", { groupId });
      const requests = await api.getJoinRequests(groupId);
      log.debug("getJoinRequests ok", { groupId, count: requests.length });
      return requests;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
