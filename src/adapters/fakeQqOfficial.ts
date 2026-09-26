import { randomUUID } from "node:crypto";

import type {
  ApproveJoinRequestOptions,
  QQOfficialAPI,
  RemoveGroupMemberOptions,
  RichMessageOptions,
} from "./qqOfficial.js";

export class FakeQQOfficialAPI implements QQOfficialAPI {
  public readonly sentMessages: Array<Record<string, unknown>> = [];
  public readonly sentPrivateMessages: Array<Record<string, unknown>> = [];
  public readonly recalledMessages: Array<[string, string]> = [];
  public readonly mutedMembers: Array<[string, string, number]> = [];
  public readonly removedMembers: Array<[string, string]> = [];
  /** 群黑名单操作记录：[groupId, userId, "add"|"del"]。 */
  public readonly blacklistOperations: Array<[string, string, "add" | "del"]> = [];
  public readonly joinRequests = new Map<string, Record<string, unknown>>();
  public readonly joinRequestReviews: Array<{
    groupId: string;
    memberOpenid: string;
    op: "approve" | "decline";
    joinRequestId?: string;
    reason?: string;
    addToMemberBlacklist?: boolean;
  }> = [];
  /** 置为 true 后 approveJoinRequest 抛出错误，便于测试失败路径。 */
  public failJoinRequestApprovals = false;
  /** 置为 true 后 getJoinRequests 抛出错误，便于测试同步失败。 */
  public failJoinRequestList = false;
  /** 互动事件回应记录：[interactionId, code]。 */
  public readonly interactionResponses: Array<[string, number]> = [];
  /** 置为 true 后 respondInteraction 抛出错误，便于测试回调失败。 */
  public failInteractionResponses = false;
  /** 置为 true 后所有单聊消息抛出错误，便于测试推送失败。 */
  public failPrivateMessages = false;
  /** 置为 true 后 Markdown 单聊消息抛出错误（纯文本仍可发送），便于测试降级。 */
  public failPrivateRichMessages = false;
  /** 置为 true 后带按钮的 Markdown 单聊消息抛出错误，便于测试「按钮未开通」降级。 */
  public failPrivateKeyboardMessages = false;
  /**
   * 带按钮消息被拒时的错误文案。
   *
   * 默认模拟「平台不支持自定义按钮」；真机踩过的另一类是**内容审核**
   * （`400 消息内容违规`，例如群规则卡片里列出了违规词），测试里可覆盖这个文案。
   */
  public keyboardRejectionMessage = "fake keyboard message failure";
  /** 置为 true 后所有群消息抛出错误，便于测试群发送失败（如 `/testat`）。 */
  public failGroupMessages = false;
  /** 置为 true 后 Markdown 群消息抛出错误（纯文本仍可发送）。 */
  public failGroupRichMessages = false;
  /** 置为 true 后群图片上传与发送都抛出错误，便于测试统计图降级。 */
  public failGroupImages = false;
  /** 群图片上传记录：`[groupId, fileName, data]`。 */
  public readonly uploadedGroupImages: Array<[string, string, Uint8Array]> = [];
  /** 群图片发送记录：`[groupId, fileInfo, msgId]`。 */
  public readonly sentGroupImages: Array<[string, string, string | undefined]> = [];

  public async getAccessToken(): Promise<string> {
    return "fake-token";
  }

  public async getGatewayUrl(): Promise<string> {
    return "wss://fake.example/websocket";
  }

  public async sendGroupMessage(
    groupId: string,
    content: string,
    msgId?: string,
    options?: RichMessageOptions,
  ): Promise<Record<string, unknown>> {
    if (this.failGroupMessages) {
      throw new Error("fake group message failure");
    }
    if (options?.markdown && this.failGroupRichMessages) {
      throw new Error("fake group rich message failure");
    }
    const messageId = randomUUID();
    this.sentMessages.push({
      groupId,
      content,
      msgId,
      messageId,
      ...richFields(options),
    });
    return { id: messageId };
  }

  public async sendPrivateMessage(
    userOpenid: string,
    content: string,
    msgId?: string,
    options?: RichMessageOptions,
  ): Promise<Record<string, unknown>> {
    if (options?.markdown && options.keyboard && this.failPrivateKeyboardMessages) {
      throw new Error(this.keyboardRejectionMessage);
    }
    if (options?.markdown && this.failPrivateRichMessages) {
      throw new Error("fake rich message failure");
    }
    if (this.failPrivateMessages) {
      throw new Error("fake private message failure");
    }
    const messageId = randomUUID();
    this.sentPrivateMessages.push({
      userOpenid,
      content,
      msgId,
      messageId,
      ...richFields(options),
    });
    return { id: messageId };
  }

  public async recallGroupMessage(groupId: string, messageId: string): Promise<void> {
    this.recalledMessages.push([groupId, messageId]);
  }

  public async muteGroupMember(
    groupId: string,
    userId: string,
    durationSeconds: number,
  ): Promise<void> {
    this.mutedMembers.push([groupId, userId, durationSeconds]);
  }

  public async removeGroupMember(
    groupId: string,
    userId: string,
    options: RemoveGroupMemberOptions = {},
  ): Promise<void> {
    this.removedMembers.push([groupId, userId]);
    if (options.addToMemberBlacklist) {
      this.blacklistOperations.push([groupId, userId, "add"]);
    }
  }

  public async updateMemberBlacklist(
    groupId: string,
    userId: string,
    add: boolean,
  ): Promise<void> {
    this.blacklistOperations.push([groupId, userId, add ? "add" : "del"]);
  }

  public async respondInteraction(
    interactionId: string,
    code = 0,
  ): Promise<void> {
    if (this.failInteractionResponses) {
      throw new Error("fake interaction response failure");
    }
    this.interactionResponses.push([interactionId, code]);
  }

  public async approveJoinRequest(
    groupId: string,
    memberOpenid: string,
    approve: boolean,
    options: ApproveJoinRequestOptions = {},
  ): Promise<void> {
    if (this.failJoinRequestApprovals) {
      throw new Error("fake approval failure");
    }
    this.joinRequestReviews.push({
      groupId,
      memberOpenid,
      op: approve ? "approve" : "decline",
      ...(options.joinRequestId ? { joinRequestId: options.joinRequestId } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.addToMemberBlacklist !== undefined
        ? { addToMemberBlacklist: options.addToMemberBlacklist }
        : {}),
    });
  }

  public async getJoinRequests(groupId: string): Promise<Record<string, unknown>[]> {
    if (this.failJoinRequestList) {
      throw new Error("fake join request list failure");
    }
    return [...this.joinRequests.values()].filter(
      (request) => request.group_id === groupId,
    );
  }

  /**
   * 群图片上传（对应官方「群聊富媒体上传」）。
   *
   * 记录 `[groupId, fileName, data]` 并返回一个可直接给 `sendGroupImage` 的
   * `file_info`；`failGroupImages` 打开时抛错，用于测试降级路径。
   */
  public async uploadGroupImage(
    groupId: string,
    fileName: string,
    data: Uint8Array,
  ): Promise<Record<string, unknown>> {
    if (this.failGroupImages) {
      throw new Error("fake group image upload failure");
    }
    this.uploadedGroupImages.push([groupId, fileName, data]);
    const fileInfo = `fake-file-info-${this.uploadedGroupImages.length}`;
    return {
      file_uuid: `fake-file-uuid-${this.uploadedGroupImages.length}`,
      file_info: fileInfo,
      ttl: 300,
    };
  }

  /** 群图片发送（官方 `msg_type=7`）；记录 `[groupId, fileInfo, msgId]`。 */
  public async sendGroupImage(
    groupId: string,
    fileInfo: string,
    msgId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.failGroupImages) {
      throw new Error("fake group image send failure");
    }
    this.sentGroupImages.push([groupId, fileInfo, msgId]);
    return { id: randomUUID() };
  }

  public addJoinRequest(
    groupId: string,
    userId: string,
    reason = "",
    requestId = randomUUID(),
  ): Record<string, unknown> {
    const request = {
      request_id: requestId,
      group_id: groupId,
      user_id: userId,
      reason,
    };
    this.joinRequests.set(requestId, request);
    return request;
  }
}

/** 只把实际存在的富消息字段写进记录，避免测试里出现 `undefined` 键。 */
function richFields(options: RichMessageOptions | undefined): Record<string, unknown> {
  if (!options?.markdown) {
    return {};
  }
  return {
    markdown: options.markdown,
    ...(options.keyboard ? { keyboard: options.keyboard } : {}),
  };
}
