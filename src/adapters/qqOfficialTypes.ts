import type { BotCacheStore } from "./botCache.js";
import { PassiveReplyQuota } from "./passiveReplyQuota.js";
import { SendThrottle } from "./sendThrottle.js";

/**
 * QQ 官方 API 的公开类型与常量：接口面、键盘结构、传输契约、端点与上限。
 */

export type JsonValue =
  | Record<string, unknown>
  | unknown[]
  | string
  | null
  | undefined;

export interface RemoveGroupMemberOptions {
  /** 移出的同时加入群黑名单（官方一次调用完成）。 */
  addToMemberBlacklist?: boolean | undefined;
}

export interface ApproveJoinRequestOptions {
  /** 拒绝理由（op=decline 时官方支持 reject_reason）。 */
  reason?: string | undefined;
  /** 入群申请 ID（join_request_id），官方推荐携带。 */
  joinRequestId?: string | undefined;
  /** op=decline 时是否同时加入群黑名单。 */
  addToMemberBlacklist?: boolean | undefined;
}

/** 按钮点击后的二次确认弹窗（官方 `action.modal`）。 */
export interface KeyboardModal {
  /** 提示文本，最多 40 个字符，不能包含 URL。 */
  content: string;
  /** 确认按钮文字，最多 4 个字符。 */
  confirmText?: string | undefined;
  /** 取消按钮文字，最多 4 个字符。 */
  cancelText?: string | undefined;
}

export interface KeyboardButtonPermission {
  /** 0=指定用户，1=管理员，2=所有人。 */
  type: 0 | 1 | 2;
  /** type=0 时有权限的用户 id 列表。 */
  specifyUserIds?: readonly string[] | undefined;
}

export interface KeyboardButtonAction {
  /** 0=跳转，1=回调，2=指令按钮（自动在输入框插入 @bot data）。 */
  type: 0 | 1 | 2;
  /** 操作数据；type=1/2 时必填。指令按钮即点击后发送的指令文本。 */
  data: string;
  permission?: KeyboardButtonPermission | undefined;
  /** 指令按钮：点击后直接自动发送 data（仅单聊，客户端版本 8983+）。 */
  enter?: boolean | undefined;
  /** 指令按钮：指令是否带引用回复本消息。 */
  reply?: boolean | undefined;
  /** 客户端不支持该按钮时弹出的提示文案。 */
  unsupportTips?: string | undefined;
  modal?: KeyboardModal | undefined;
}

export interface KeyboardButton {
  /** 同一键盘内唯一。 */
  id: string;
  /** 按钮文字，最多 10 个字符。 */
  label: string;
  /** 点击后的文字；不传则保持不变。 */
  visitedLabel?: string | undefined;
  /** 0 灰色线框 / 1 蓝色线框 / 3 白底红字 / 4 蓝底白字。 */
  style?: 0 | 1 | 3 | 4 | undefined;
  action: KeyboardButtonAction;
}

export interface KeyboardPayload {
  content: {
    /** 最多 5 行，每行最多 5 个按钮。 */
    rows: ReadonlyArray<{ buttons: readonly KeyboardButton[] }>;
  };
}

/** 富消息（Markdown + 内嵌按钮）；目前用于入群申请推送卡片。 */
export interface RichMessageOptions {
  /** 自定义 Markdown 正文（`msg_type=2`）。单聊/群聊已对所有机器人开放。 */
  markdown?: string | undefined;
  /** 消息底部按钮；仅挂在 Markdown 消息上。自定义按钮为官方内邀能力，失败时自动降级。 */
  keyboard?: KeyboardPayload | undefined;
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
    options?: RichMessageOptions,
  ): Promise<Record<string, unknown>>;
  sendPrivateMessage(
    userOpenid: string,
    content: string,
    msgId?: string,
    options?: RichMessageOptions,
  ): Promise<Record<string, unknown>>;
  recallGroupMessage(groupId: string, messageId: string): Promise<void>;
  muteGroupMember(
    groupId: string,
    userId: string,
    durationSeconds: number,
  ): Promise<void>;
  removeGroupMember(
    groupId: string,
    userId: string,
    options?: RemoveGroupMemberOptions,
  ): Promise<void>;
  /** 群黑名单操作：add 加入黑名单（要求目标不在群中），del 移出黑名单。 */
  updateMemberBlacklist(
    groupId: string,
    userId: string,
    add: boolean,
  ): Promise<void>;
  /**
   * 回应互动事件（官方 `PUT /interactions/{interaction_id}`）。
   *
   * 收到 `INTERACTION_CREATE`（`type=11` 消息按钮 / `type=12` 快捷菜单）后必须调用，
   * 否则客户端会一直 loading 直到超时；同一 `interaction_id` 只能回应一次。
   * `code`：0=成功（默认）、1=操作失败、2=操作频繁、3=重复操作、4=没有权限、5=仅管理员操作。
   */
  respondInteraction(interactionId: string, code?: number): Promise<void>;
  approveJoinRequest(
    groupId: string,
    memberOpenid: string,
    approve: boolean,
    options?: ApproveJoinRequestOptions,
  ): Promise<void>;
  getJoinRequests(groupId: string): Promise<Record<string, unknown>[]>;
  /**
   * 上传一张图片到群聊，返回官方响应（含 `file_info`）。
   *
   * 官方没有「multipart 直传字节」的接口，图片只能两条路进平台：
   * 1. `url` 直传（平台自己去下载转存）；
   * 2. `upload_prepare` → 分片 `PUT` 预签名 URL → `upload_part_finish` → 本接口带 `upload_id` 合并。
   *
   * 这里实现第 2 条（本地生成的 PNG 没有公网 URL）：先预上传、再逐片直传、
   * 最后带 `upload_id` 调 `POST /v2/groups/{group_openid}/files` 完成合并，
   * 得到 `{ file_info }` 供 `sendGroupImage` 使用。任何一步失败都抛错，
   * 调用方（活动统计）据此降级为文字统计卡。
   */
  uploadGroupImage(
    groupId: string,
    fileName: string,
    data: Uint8Array,
  ): Promise<Record<string, unknown>>;
  /**
   * 发送一张已上传的群图片（官方 `msg_type=7` 富媒体消息）。
   *
   * 请求体：`{ msg_type: 7, media: { file_info }, msg_id? }`；`file_info` 直接透传
   * 上传接口的返回值（内部是序列化二进制，官方要求不要解析）。
   */
  sendGroupImage(
    groupId: string,
    fileInfo: string,
    msgId?: string,
  ): Promise<Record<string, unknown>>;
}

export interface HttpResponse {
  statusCode: number;
  jsonData?: unknown;
  text: string;
  headers?: Record<string, string>;
}

/** 原始二进制请求体（富媒体分片上传用，不能走 JSON 序列化）。 */
export interface RawBody {
  contentType: string;
  body: Uint8Array;
}

export interface AsyncTransport {
  request(
    method: string,
    url: string,
    headers: Record<string, string>,
    json?: JsonValue,
  ): Promise<HttpResponse>;
  /**
   * 直接发送二进制请求体（可选能力）。
   *
   * 官方富媒体分片上传要先把文件分片 `PUT` 到平台给的预签名 URL，
   * 这个请求既不是 JSON、也不带机器人鉴权头，因此单独开一个入口。
   * 未实现时调用方会得到明确错误并降级（例如统计图退化为文字统计卡）。
   */
  requestRaw?(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: RawBody,
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
  memberBlacklist: string;
  /** 互动事件回应：`PUT /interactions/{interactionId}`。 */
  interaction: string;
  /**
   * 群聊富媒体上传（官方文档「群聊富媒体上传」）。
   *
   * `POST /v2/groups/{group_openid}/files`，请求体
   * `{ file_type, url?, srv_send_msg, file_name?, upload_id? }`；响应
   * `{ file_uuid, file_info, ttl, id?, raw_url? }`。`file_info` 用于
   * 「发送群聊消息」的 `media.file_info`（`msg_type=7`）。
   */
  groupFileUpload: string;
  /**
   * 群聊富媒体预上传（官方文档「群聊富媒体预上传」）。
   *
   * 用于拿到 `upload_id` 与各分片预签名 URL；随后逐片 `PUT`，每片成功后
   * 调 `groupFileUploadPartFinish` 通知服务端，最后带 `upload_id` 调
   * `groupFileUpload` 合并（官方推荐大文件走分片，小文件同样可用）。
   */
  groupFileUploadPrepare: string;
  /** 群聊分片上传完成（官方文档「群聊分片上传完成」）。 */
  groupFileUploadPartFinish: string;
}

export const DEFAULT_ENDPOINTS: QQOfficialEndpoints = {
  // 官方文档自 2026-08-10 起统一调用域名为 api.bot.qq.com
  baseUrl: "https://api.bot.qq.com",
  tokenUrl: "https://bots.qq.com/app/getAppAccessToken",
  gatewayUrl: "/gateway",
  sendGroupMessage: "/v2/groups/{groupId}/messages",
  sendPrivateMessage: "/v2/users/{userOpenid}/messages",
  recallGroupMessage: "/v2/groups/{groupId}/messages/{messageId}",
  muteGroupMember: "/v2/groups/{groupId}/restrict_chat_setting",
  removeGroupMember: "/v2/groups/{groupId}/batch_remove_members",
  approveJoinRequest: "/v2/groups/{groupId}/approval_join_request/{memberOpenid}",
  joinRequestList: "/v2/groups/{groupId}/join_request_list",
  memberBlacklist: "/v2/groups/{groupId}/member_blacklist",
  interaction: "/interactions/{interactionId}",
  groupFileUpload: "/v2/groups/{groupId}/files",
  groupFileUploadPrepare: "/v2/groups/{groupId}/upload_prepare",
  groupFileUploadPartFinish: "/v2/groups/{groupId}/upload_part_finish",
};

export const DEFAULT_TOKEN_REFRESH_MARGIN_MS = 60_000;
export const DEFAULT_GATEWAY_COOLDOWN_MS = 60_000;
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 7_200;
/** 官方限制：单次禁言最长 30 天。 */
export const MAX_MUTE_DURATION_SECONDS = 30 * 24 * 60 * 60;
/** 入群申请列表最多翻页次数，避免异常游标导致死循环。 */
export const MAX_JOIN_REQUEST_PAGES = 5;
/** 官方富媒体类型：1=图片（png/jpg）。 */
export const GROUP_FILE_TYPE_IMAGE = 1;
/** `upload_prepare` 未给出 `block_size` 时的兜底分片大小（4MB）。 */
export const DEFAULT_UPLOAD_BLOCK_SIZE = 4 * 1024 * 1024;
/** 分片上传允许的最大片数，避免异常响应导致死循环。 */
export const MAX_UPLOAD_BLOCKS = 1_000;

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
