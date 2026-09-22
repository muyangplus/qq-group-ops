export type JsonValue =
  | Record<string, unknown>
  | unknown[]
  | string
  | null
  | undefined;

export interface QQOfficialAPI {
  sendGroupMessage(
    groupId: string,
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
    reason?: string,
  ): Promise<void>;
  getJoinRequests(groupId: string): Promise<Record<string, unknown>[]>;
}

export interface HttpResponse {
  statusCode: number;
  jsonData?: unknown;
  text: string;
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
  sendGroupMessage: string;
  recallGroupMessage: string;
  muteGroupMember: string;
  removeGroupMember: string;
  approveJoinRequest: string;
  joinRequestList: string;
}

export const DEFAULT_ENDPOINTS: QQOfficialEndpoints = {
  baseUrl: "https://api.sgroup.qq.com",
  tokenUrl: "https://bots.qq.com/app/getAppAccessToken",
  sendGroupMessage: "/v2/groups/{groupId}/messages",
  recallGroupMessage: "/v2/groups/{groupId}/messages/{messageId}",
  muteGroupMember: "/v2/groups/{groupId}/restrict_chat_setting",
  removeGroupMember: "/v2/groups/{groupId}/batch_remove_members",
  approveJoinRequest: "/v2/groups/{groupId}/approval_join_request/{memberOpenid}",
  joinRequestList: "/v2/groups/{groupId}/join_request_list",
};

export class QQOfficialAPIError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
    public readonly payload?: unknown,
  ) {
    super(`QQ official API error ${statusCode}: ${message}`);
    this.name = "QQOfficialAPIError";
  }
}

export interface QQOfficialClientOptions {
  token?: string;
  transport?: AsyncTransport;
  endpoints?: QQOfficialEndpoints;
  headers?: Record<string, string>;
}

export class QQOfficialClient implements QQOfficialAPI {
  public readonly appId: string;
  private readonly clientSecret: string;
  private readonly transport: AsyncTransport | undefined;
  private readonly endpoints: QQOfficialEndpoints;
  private readonly extraHeaders: Record<string, string>;
  private tokenValue: string;

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
    this.tokenValue = options.token ?? "";
  }

  public get token(): string {
    return this.tokenValue;
  }

  public async close(): Promise<void> {
    await this.transport?.aclose();
  }

  public async ensureToken(): Promise<string> {
    if (this.tokenValue) {
      return this.tokenValue;
    }
    if (!this.transport) {
      throw new Error("transport is required to fetch access token");
    }
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
    this.tokenValue = token;
    return token;
  }

  public async sendGroupMessage(
    groupId: string,
    content: string,
    msgId?: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { content };
    if (msgId) {
      payload.msg_id = msgId;
    }
    const response = await this.request(
      "POST",
      fill(this.endpoints.sendGroupMessage, { groupId }),
      payload,
    );
    return isRecord(response.jsonData) ? response.jsonData : {};
  }

  public async recallGroupMessage(groupId: string, messageId: string): Promise<void> {
    await this.request(
      "DELETE",
      fill(this.endpoints.recallGroupMessage, { groupId, messageId }),
    );
  }

  public async muteGroupMember(
    _groupId: string,
    _userId: string,
    _durationSeconds: number,
  ): Promise<void> {
    throw new Error(
      "Verify official restrict_chat_setting request body before enabling",
    );
  }

  public async removeGroupMember(_groupId: string, _userId: string): Promise<void> {
    throw new Error(
      "Verify official batch_remove_members request body before enabling",
    );
  }

  public async approveJoinRequest(
    groupId: string,
    memberOpenid: string,
    approve: boolean,
    reason = "",
  ): Promise<void> {
    await this.request(
      "POST",
      fill(this.endpoints.approveJoinRequest, { groupId, memberOpenid }),
      { approve, reason },
    );
  }

  public async getJoinRequests(groupId: string): Promise<Record<string, unknown>[]> {
    const response = await this.request(
      "GET",
      fill(this.endpoints.joinRequestList, { groupId }),
    );
    if (Array.isArray(response.jsonData)) {
      return response.jsonData.filter(isRecord);
    }
    if (isRecord(response.jsonData) && Array.isArray(response.jsonData.data)) {
      return response.jsonData.data.filter(isRecord);
    }
    return [];
  }

  private async request(
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

function raiseForStatus(response: HttpResponse): void {
  if (response.statusCode < 400) {
    return;
  }
  const payload = response.jsonData ?? response.text;
  const message = isRecord(payload)
    ? String(payload.message ?? payload.msg ?? JSON.stringify(payload))
    : String(payload);
  throw new QQOfficialAPIError(response.statusCode, message, payload);
}
