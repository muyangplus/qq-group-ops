import { FetchTransport } from "./adapters/fetchTransport.js";
import { QQOfficialClient } from "./adapters/qqOfficial.js";
import { loadSettings } from "./config.js";
import { loadEnvFile } from "./env.js";
import { isLikelyGroupNumber, runPhase0Check } from "./phase0.js";

async function main(): Promise<void> {
  loadEnvFile();
  const settings = loadSettings();
  const groupId = process.env.QQ_BOT_TEST_GROUP_ID;

  if (!settings.qqBotAppId || !settings.qqBotClientSecret || !groupId) {
    console.error(
      "缺少配置：需要 QQ_BOT_APP_ID、QQ_BOT_CLIENT_SECRET 和 QQ_BOT_TEST_GROUP_ID。",
    );
    console.error(
      "注意：QQ_BOT_TEST_GROUP_ID 必须是 group_openid，不是普通 QQ 群号；group_openid 无法由群号换算，只能从官方事件或查询接口获取。",
    );
    process.exitCode = 1;
    return;
  }

  if (isLikelyGroupNumber(groupId)) {
    console.warn(
      "警告：QQ_BOT_TEST_GROUP_ID 看起来像普通 QQ 群号。官方要求 group_openid，无法由群号换算，只能从官方事件或查询接口获取。",
    );
  }

  const client = new QQOfficialClient(
    settings.qqBotAppId,
    settings.qqBotClientSecret,
    {
      token: settings.qqBotToken,
      transport: new FetchTransport(),
    },
  );

  try {
    const result = await runPhase0Check(client, groupId, {
      sendTestMessage: process.env.PHASE0_SEND_TEST_MESSAGE === "true",
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
