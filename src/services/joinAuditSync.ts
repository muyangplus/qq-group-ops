import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import type { JoinAuditService, JoinRequest } from "./joinAudit.js";

export class JoinRequestSyncService {
  public constructor(
    private readonly api: QQOfficialAPI,
    private readonly joinAudit: JoinAuditService,
  ) {}

  public async syncGroup(groupId: string): Promise<JoinRequest[]> {
    const rawRequests = await this.api.getJoinRequests(groupId);
    for (const item of rawRequests) {
      const requestId = firstString(item, "request_id", "id", "flag");
      const userId = firstString(item, "user_id", "member_openid", "user_openid");
      const reason = firstString(item, "reason", "comment") ?? "";
      if (!requestId || !userId) {
        continue;
      }
      try {
        this.joinAudit.submit(groupId, userId, reason, requestId);
      } catch {
        // 已同步过的申请不重复写入。
      }
    }
    return this.joinAudit.pending(groupId);
  }
}

function firstString(
  item: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}
