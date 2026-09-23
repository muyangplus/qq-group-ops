import { randomUUID } from "node:crypto";

import type {
  ApproveJoinRequestOptions,
  QQOfficialAPI,
} from "./qqOfficial.js";

export class FakeQQOfficialAPI implements QQOfficialAPI {
  public readonly sentMessages: Array<Record<string, unknown>> = [];
  public readonly sentPrivateMessages: Array<Record<string, unknown>> = [];
  public readonly recalledMessages: Array<[string, string]> = [];
  public readonly mutedMembers: Array<[string, string, number]> = [];
  public readonly removedMembers: Array<[string, string]> = [];
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
  ): Promise<Record<string, unknown>> {
    const messageId = randomUUID();
    this.sentMessages.push({ groupId, content, msgId, messageId });
    return { id: messageId };
  }

  public async sendPrivateMessage(
    userOpenid: string,
    content: string,
    msgId?: string,
  ): Promise<Record<string, unknown>> {
    const messageId = randomUUID();
    this.sentPrivateMessages.push({ userOpenid, content, msgId, messageId });
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

  public async removeGroupMember(groupId: string, userId: string): Promise<void> {
    this.removedMembers.push([groupId, userId]);
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
