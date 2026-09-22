import type { QQOfficialAPI } from "./adapters/qqOfficial.js";

export interface Phase0CheckOptions {
  sendTestMessage?: boolean;
}

export interface Phase0CheckResult {
  tokenAcquired: boolean;
  joinRequestCount: number;
  sentMessageId?: string;
  recallAttempted: boolean;
  errors: string[];
}

export async function runPhase0Check(
  api: QQOfficialAPI,
  groupId: string,
  options: Phase0CheckOptions = {},
): Promise<Phase0CheckResult> {
  const result: Phase0CheckResult = {
    tokenAcquired: false,
    joinRequestCount: 0,
    recallAttempted: false,
    errors: [],
  };

  try {
    const requests = await api.getJoinRequests(groupId);
    result.tokenAcquired = true;
    result.joinRequestCount = requests.length;
  } catch (error) {
    result.errors.push(`getJoinRequests: ${formatError(error)}`);
  }

  if (options.sendTestMessage) {
    try {
      const sent = await api.sendGroupMessage(groupId, "Phase 0 test message");
      const messageId = typeof sent.id === "string" ? sent.id : undefined;
      if (!messageId) {
        result.errors.push("sendGroupMessage: missing id");
      } else {
        result.sentMessageId = messageId;
        try {
          await api.recallGroupMessage(groupId, messageId);
          result.recallAttempted = true;
        } catch (error) {
          result.errors.push(`recallGroupMessage: ${formatError(error)}`);
        }
      }
    } catch (error) {
      result.errors.push(`sendGroupMessage: ${formatError(error)}`);
    }
  }

  return result;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
