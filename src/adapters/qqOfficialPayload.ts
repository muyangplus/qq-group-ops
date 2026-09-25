import { QQOfficialAPIError } from "./qqOfficialError.js";
import {
  type KeyboardPayload,
  type RichMessageOptions,
  type HttpResponse,
  MAX_UPLOAD_BLOCKS,
} from "./qqOfficialTypes.js";

/**
 * QQ 官方 API 的纯载荷与响应处理：消息 / 键盘序列化、媒体上传分片、错误与重试解析。
 */

export interface JoinRequestPage {
  requests: Record<string, unknown>[];
  nextCursor: string | undefined;
}

/** `upload_prepare` 解析结果：上传任务 id、分片大小与各片预签名 URL。 */
export interface PreparedUpload {
  uploadId: string;
  blockSize: number;
  urls: string[];
}

/**
 * 组装 `msg_type=7` 富媒体消息体。
 *
 * 官方要点：`media.file_info` 直接透传上传接口返回值，`msg_id` 存在时按被动回复发送。
 */
export function buildGroupImagePayload(
  fileInfo: string,
  msgId?: string,
): Record<string, unknown> {
  return {
    msg_type: 7,
    media: { file_info: fileInfo },
    ...(msgId ? { msg_id: msgId } : {}),
  };
}

/** 从上传响应里取 `file_info`；缺失时抛错（调用方降级，不假装成功）。 */
export function extractFileInfo(payload: unknown): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {};
  const fileInfo = record.file_info;
  if (typeof fileInfo !== "string" || fileInfo.length === 0) {
    throw new QQOfficialAPIError(200, "file_info missing in upload response", payload, {
      errorCode: extractErrorCode(payload),
    });
  }
  return record;
}

/**
 * 解析 `upload_prepare` 响应。
 *
 * 兼容官方可能给出的几种字段命名（`upload_id` / `uploadId`、
 * `block_size` / `blockSize`、`upload_urls` / `urls` / `parts[].url`）；
 * 分片数为 1 时也接受单个 `upload_url`。缺失 `upload_id` 或 URL 时抛错。
 */
export function parsePreparedUpload(
  payload: unknown,
  totalSize: number,
): PreparedUpload {
  const record = isRecord(payload) ? payload : {};
  const uploadId =
    firstString(record, ["upload_id", "uploadId", "id"]) ??
    firstString(isRecord(record.data) ? record.data : {}, [
      "upload_id",
      "uploadId",
    ]);
  if (!uploadId) {
    throw new QQOfficialAPIError(
      200,
      "upload_id missing in upload_prepare response",
      payload,
      { errorCode: extractErrorCode(payload) },
    );
  }
  const blockSize = normalizeBlockSize(
    firstNumber(record, ["block_size", "blockSize"]) ??
      firstNumber(isRecord(record.data) ? record.data : {}, [
        "block_size",
        "blockSize",
      ]),
    totalSize,
  );
  const urls = collectUploadUrls(record);
  if (urls.length === 0) {
    throw new QQOfficialAPIError(
      200,
      "upload urls missing in upload_prepare response",
      payload,
      { errorCode: extractErrorCode(payload) },
    );
  }
  return { uploadId, blockSize, urls };
}

function collectUploadUrls(record: Record<string, unknown>): string[] {
  const direct = [
    record.upload_urls,
    record.uploadUrls,
    record.urls,
    record.parts,
  ];
  for (const candidate of direct) {
    const urls = urlsOf(candidate);
    if (urls.length > 0) {
      return urls;
    }
  }
  const single = firstString(record, ["upload_url", "uploadUrl"]);
  return single ? [single] : [];
}

function urlsOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      urls.push(item);
      continue;
    }
    if (isRecord(item)) {
      const url = firstString(item, ["url", "upload_url", "uploadUrl", "presigned_url"]);
      if (url) {
        urls.push(url);
      }
    }
  }
  return urls;
}

function normalizeBlockSize(value: number | undefined, totalSize: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return Math.max(totalSize, 1);
  }
  const blockSize = Math.floor(value);
  const blocks = Math.ceil(totalSize / blockSize);
  if (blocks > MAX_UPLOAD_BLOCKS) {
    throw new Error(
      `upload_prepare block_size ${blockSize} would need ${blocks} blocks (max ${MAX_UPLOAD_BLOCKS})`,
    );
  }
  return blockSize;
}

export function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/u.test(value)) {
      return Number.parseInt(value, 10);
    }
  }
  return undefined;
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

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`missing endpoint parameter: ${key}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * 组装发消息请求体。
 *
 * 纯文本默认保持 `{ content }`（官方 `msg_type` 默认 0）；单聊接口历史上显式带
 * `msg_type: 0`，用 `explicitTextMsgType` 保留该行为。传入 Markdown 时使用
 * `msg_type=2` + `markdown.content`（此时不能再传 `content`），并把内核按钮挂在
 * `keyboard` 上。单聊与群聊接口的字段结构一致。
 */
export function buildMessagePayload(
  content: string,
  msgId: string | undefined,
  options: RichMessageOptions | undefined,
  explicitTextMsgType = false,
): Record<string, unknown> {
  const markdown = options?.markdown?.trim();
  const payload: Record<string, unknown> = markdown
    ? { msg_type: 2, markdown: { content: markdown } }
    : explicitTextMsgType
      ? { msg_type: 0, content }
      : { content };
  if (markdown && options?.keyboard) {
    payload.keyboard = serializeKeyboard(options.keyboard);
  }
  if (msgId) {
    payload.msg_id = msgId;
  }
  return payload;
}

/** 把内部 camelCase 按钮结构转成官方下划线字段。 */
function serializeKeyboard(keyboard: KeyboardPayload): Record<string, unknown> {
  return {
    content: {
      rows: keyboard.content.rows.map((row) => ({
        buttons: row.buttons.map((button) => ({
          id: button.id,
          render_data: {
            label: button.label,
            visited_label: button.visitedLabel ?? button.label,
            style: button.style ?? 1,
          },
          action: {
            type: button.action.type,
            data: button.action.data,
            permission: {
              type: button.action.permission?.type ?? 2,
              ...(button.action.permission?.specifyUserIds
                ? { specify_user_ids: [...button.action.permission.specifyUserIds] }
                : {}),
            },
            ...(button.action.enter !== undefined
              ? { enter: button.action.enter }
              : {}),
            ...(button.action.reply !== undefined
              ? { reply: button.action.reply }
              : {}),
            ...(button.action.unsupportTips !== undefined
              ? { unsupport_tips: button.action.unsupportTips }
              : {}),
            ...(button.action.modal
              ? {
                  modal: {
                    content: button.action.modal.content,
                    ...(button.action.modal.confirmText !== undefined
                      ? { confirm_text: button.action.modal.confirmText }
                      : {}),
                    ...(button.action.modal.cancelText !== undefined
                      ? { cancel_text: button.action.modal.cancelText }
                      : {}),
                  },
                }
              : {}),
          },
        })),
      })),
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof QQOfficialAPIError && error.statusCode === 401;
}

export function raiseForStatus(response: HttpResponse): void {
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

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

