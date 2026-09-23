import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileBotCacheStore,
  MemoryBotCacheStore,
} from "../src/adapters/botCache.js";
import {
  DEFAULT_ENDPOINTS,
  QQOfficialAPIError,
  QQOfficialClient,
} from "../src/adapters/qqOfficial.js";
import type {
  AsyncTransport,
  HttpResponse,
  JsonValue,
} from "../src/adapters/qqOfficial.js";
import { SendThrottle } from "../src/adapters/sendThrottle.js";

interface CallRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  json?: JsonValue;
}

class FakeTransport implements AsyncTransport {
  public readonly calls: CallRecord[] = [];
  private readonly responses: HttpResponse[];

  public constructor(responses: HttpResponse[] = []) {
    this.responses = [...responses];
  }

  public async request(
    method: string,
    url: string,
    headers: Record<string, string>,
    json?: JsonValue,
  ): Promise<HttpResponse> {
    this.calls.push({ method, url, headers, json });
    return (
      this.responses.shift() ?? { statusCode: 200, jsonData: {}, text: "" }
    );
  }

  public async aclose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("QQOfficialClient", () => {
  it("fetches a token and sends a group message", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: { access_token: "tok" }, text: "" },
      { statusCode: 200, jsonData: { id: "mid" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", { transport });

    const result = await client.sendGroupMessage("g1", "hello", "m1");

    expect(result).toEqual({ id: "mid" });
    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toBe(
      "https://bots.qq.com/app/getAppAccessToken",
    );
    expect(transport.calls[0]?.json).toEqual({
      appId: "app",
      clientSecret: "secret",
    });
    expect(transport.calls[1]?.method).toBe("POST");
    expect(transport.calls[1]?.url).toContain("/v2/groups/g1/messages");
    expect(transport.calls[1]?.headers.Authorization).toBe("QQBot tok");
    expect(transport.calls[1]?.json).toEqual({
      content: "hello",
      msg_id: "m1",
    });
  });

  it("skips token fetch when token is provided", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.recallGroupMessage("g1", "m1");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.method).toBe("DELETE");
    expect(transport.calls[0]?.url).toContain("/v2/groups/g1/messages/m1");
  });

  it("approves join requests with the official payload", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.approveJoinRequest("g1", "u1", true, {
      joinRequestId: "r1",
    });

    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toContain(
      "/v2/groups/g1/approval_join_request/u1",
    );
    expect(transport.calls[0]?.json).toEqual({
      op: "approve",
      join_request_id: "r1",
    });
  });

  it("declines join requests with a reason and blacklist flag", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.approveJoinRequest("g1", "u1", false, {
      joinRequestId: "r1",
      reason: "资料不完整",
      addToMemberBlacklist: true,
    });

    expect(transport.calls[0]?.json).toEqual({
      op: "decline",
      join_request_id: "r1",
      reject_reason: "资料不完整",
      add_to_member_blacklist: true,
    });
  });

  it("mutes members with mute_expire_at", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
      clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    await client.muteGroupMember("g1", "u1", 600);

    expect(transport.calls[0]?.url).toContain(
      "/v2/groups/g1/restrict_chat_setting",
    );
    expect(transport.calls[0]?.json).toEqual({
      members: [
        {
          op: "add",
          member_openid: "u1",
          mute_expire_at: "2026-01-01T00:10:00.000Z",
        },
      ],
    });
  });

  it("unmutes members when the duration is zero", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.muteGroupMember("g1", "u1", 0);

    expect(transport.calls[0]?.json).toEqual({
      members: [{ op: "del", member_openid: "u1", mute_expire_at: "" }],
    });
  });

  it("caps mute duration at 30 days", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
      clock: () => 0,
    });

    await client.muteGroupMember("g1", "u1", 999 * 24 * 60 * 60);

    const payload = transport.calls[0]?.json as {
      members: Array<{ mute_expire_at: string }>;
    };
    expect(payload.members[0]?.mute_expire_at).toBe(
      new Date(30 * 24 * 60 * 60 * 1_000).toISOString(),
    );
  });

  it("removes members with member_openids", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.removeGroupMember("g1", "u1");

    expect(transport.calls[0]?.url).toContain(
      "/v2/groups/g1/batch_remove_members",
    );
    expect(transport.calls[0]?.json).toEqual({ member_openids: ["u1"] });
  });

  it("stops passive replies after five messages for the same msg_id", async () => {
    const transport = new FakeTransport(
      Array.from({ length: 5 }, () => ({
        statusCode: 200,
        jsonData: {},
        text: "",
      })),
    );
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
      sendThrottle: new SendThrottle({ minIntervalMs: 0 }),
    });

    for (let index = 0; index < 5; index += 1) {
      await client.sendPrivateMessage("u1", `reply ${index}`, "m1");
    }

    const error = (await client
      .sendPrivateMessage("u1", "reply 6", "m1")
      .catch((caught: unknown) => caught)) as QQOfficialAPIError | undefined;

    expect(error).toBeInstanceOf(QQOfficialAPIError);
    expect(error?.errorCode).toBe(22009);
    expect(error?.isRateLimited).toBe(true);
    // 第 6 次不会打到接口
    expect(transport.calls).toHaveLength(5);
  });

  it("reads join request lists with cursor pagination", async () => {
    const transport = new FakeTransport([
      {
        statusCode: 200,
        jsonData: { list: [{ join_request_id: "r1" }], next_cursor: "c2" },
        text: "",
      },
      {
        statusCode: 200,
        jsonData: { list: [{ join_request_id: "r2" }], next_cursor: "" },
        text: "",
      },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await expect(client.getJoinRequests("g1")).resolves.toEqual([
      { join_request_id: "r1" },
      { join_request_id: "r2" },
    ]);
    expect(transport.calls[0]?.url).toContain("/v2/groups/g1/join_request_list");
    expect(transport.calls[1]?.url).toContain("cursor=c2");
  });

  it("raises API errors", async () => {
    const transport = new FakeTransport([
      { statusCode: 403, jsonData: { message: "forbidden" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await expect(client.getJoinRequests("g1")).rejects.toBeInstanceOf(
      QQOfficialAPIError,
    );
  });

  it("sends private messages", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: { id: "pmid" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await expect(
      client.sendPrivateMessage("u1", "hello", "m1"),
    ).resolves.toEqual({ id: "pmid" });
    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toContain("/v2/users/u1/messages");
    expect(transport.calls[0]?.json).toEqual({
      msg_type: 0,
      content: "hello",
      msg_id: "m1",
    });
  });

  it("sends markdown with an inline keyboard in private messages", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: { id: "pmid" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.sendPrivateMessage("u1", "", undefined, {
      markdown: "## 新的入群申请",
      keyboard: {
        content: {
          rows: [
            {
              buttons: [
                {
                  id: "approve",
                  label: "同意",
                  action: {
                    type: 2,
                    data: "/approve g1 r1",
                    permission: { type: 0, specifyUserIds: ["admin"] },
                    enter: true,
                    unsupportTips: "请直接发送 /approve",
                    modal: { content: "确认通过？", confirmText: "通过" },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    expect(transport.calls[0]?.json).toEqual({
      msg_type: 2,
      markdown: { content: "## 新的入群申请" },
      keyboard: {
        content: {
          rows: [
            {
              buttons: [
                {
                  id: "approve",
                  render_data: {
                    label: "同意",
                    visited_label: "同意",
                    style: 1,
                  },
                  action: {
                    type: 2,
                    data: "/approve g1 r1",
                    permission: { type: 0, specify_user_ids: ["admin"] },
                    enter: true,
                    unsupport_tips: "请直接发送 /approve",
                    modal: { content: "确认通过？", confirm_text: "通过" },
                  },
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("supports custom endpoints", async () => {    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
      endpoints: {
        ...DEFAULT_ENDPOINTS,
        baseUrl: "https://example.test",
        sendGroupMessage: "/custom/{groupId}/send",
      },
    });

    await client.sendGroupMessage("g1", "hello");

    expect(transport.calls[0]?.url).toBe("https://example.test/custom/g1/send");
  });

  it("reads the gateway URL", async () => {
    const transport = new FakeTransport([
      {
        statusCode: 200,
        jsonData: { url: "wss://gateway.example/websocket" },
        text: "",
      },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await expect(client.getGatewayUrl()).resolves.toBe(
      "wss://gateway.example/websocket",
    );
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.url).toBe("https://api.bot.qq.com/gateway");
  });

  it("returns the access token", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: { access_token: "tok" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", { transport });
    await expect(client.getAccessToken()).resolves.toBe("tok");
  });
});

describe("QQOfficialClient caching and rate limiting", () => {
  it("reuses a cached access token without calling the token endpoint", async () => {
    const store = new MemoryBotCacheStore();
    await store.save({
      appId: "app",
      accessToken: "cached-token",
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      transport,
      cacheStore: store,
    });

    await client.recallGroupMessage("g1", "m1");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.headers.Authorization).toBe("QQBot cached-token");
  });

  it("persists a freshly fetched access token", async () => {
    const store = new MemoryBotCacheStore();
    const transport = new FakeTransport([
      {
        statusCode: 200,
        jsonData: { access_token: "tok", expires_in: 7_200 },
        text: "",
      },
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      transport,
      cacheStore: store,
    });

    await client.recallGroupMessage("g1", "m1");

    const cached = await store.load("app");
    expect(cached?.accessToken).toBe("tok");
    expect(cached?.accessTokenExpiresAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("refreshes an expired cached token", async () => {
    const store = new MemoryBotCacheStore();
    await store.save({
      appId: "app",
      accessToken: "stale",
      accessTokenExpiresAt: Date.now() - 1_000,
    });
    const transport = new FakeTransport([
      {
        statusCode: 200,
        jsonData: { access_token: "fresh", expires_in: 7_200 },
        text: "",
      },
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      transport,
      cacheStore: store,
    });

    await client.recallGroupMessage("g1", "m1");

    expect(transport.calls[0]?.url).toContain("getAppAccessToken");
    expect(transport.calls[1]?.headers.Authorization).toBe("QQBot fresh");
  });

  it("deduplicates concurrent token requests", async () => {
    const transport = new FakeTransport([
      {
        statusCode: 200,
        jsonData: { access_token: "tok", expires_in: 7_200 },
        text: "",
      },
    ]);
    const client = new QQOfficialClient("app", "secret", { transport });

    await Promise.all([client.getAccessToken(), client.getAccessToken()]);

    expect(transport.calls).toHaveLength(1);
  });

  it("caches the gateway url in memory", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: { url: "wss://gw" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await expect(client.getGatewayUrl()).resolves.toBe("wss://gw");
    await expect(client.getGatewayUrl()).resolves.toBe("wss://gw");
    expect(transport.calls).toHaveLength(1);
  });

  it("restores the gateway url from the persistent cache", async () => {
    const store = new MemoryBotCacheStore();
    await store.save({ appId: "app", gatewayUrl: "wss://cached" });
    const transport = new FakeTransport();
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
      cacheStore: store,
    });

    await expect(client.getGatewayUrl()).resolves.toBe("wss://cached");
    expect(transport.calls).toHaveLength(0);
    await expect(client.cacheStatus()).resolves.toEqual({
      tokenCached: false,
      gatewayUrlCached: true,
    });
  });

  it("enters cooldown after a gateway rate limit and stops calling the API", async () => {
    const transport = new FakeTransport([
      {
        statusCode: 400,
        jsonData: { err_code: 100017, message: "接口调用超过频率限制" },
        text: "",
      },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
      rateLimitCooldownMs: 60_000,
    });

    const error = (await client.getGatewayUrl().catch((caught: unknown) => caught)) as
      | QQOfficialAPIError
      | undefined;

    expect(error).toBeInstanceOf(QQOfficialAPIError);
    expect(error?.errorCode).toBe(100017);
    expect(error?.isRateLimited).toBe(true);

    await expect(client.getGatewayUrl()).rejects.toThrow(/cooling down/u);
    expect(transport.calls).toHaveLength(1);
  });

  it("recognizes nested string error codes as rate limits", async () => {
    const transport = new FakeTransport([
      {
        statusCode: 400,
        jsonData: { data: { err_code: "40023001" } },
        text: "",
      },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    const error = (await client
      .recallGroupMessage("g1", "m1")
      .catch((caught: unknown) => caught)) as QQOfficialAPIError | undefined;

    expect(error?.errorCode).toBe(40023001);
    expect(error?.isRateLimited).toBe(true);
  });

  it("refreshes the token once when the server rejects it", async () => {
    const transport = new FakeTransport([
      {
        statusCode: 200,
        jsonData: { access_token: "tok1", expires_in: 7_200 },
        text: "",
      },
      { statusCode: 401, jsonData: { message: "token expired" }, text: "" },
      {
        statusCode: 200,
        jsonData: { access_token: "tok2", expires_in: 7_200 },
        text: "",
      },
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", { transport });

    await client.recallGroupMessage("g1", "m1");

    expect(transport.calls).toHaveLength(4);
    expect(transport.calls[1]?.headers.Authorization).toBe("QQBot tok1");
    expect(transport.calls[3]?.headers.Authorization).toBe("QQBot tok2");
  });

  it("retries sends on rate limit errors", async () => {
    const store = new MemoryBotCacheStore();
    await store.save({
      appId: "app",
      accessToken: "tok",
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });
    const transport = new FakeTransport([
      { statusCode: 400, jsonData: { err_code: 22009 }, text: "" },
      { statusCode: 200, jsonData: { id: "mid" }, text: "" },
    ]);
    const sleeps: number[] = [];
    const client = new QQOfficialClient("app", "secret", {
      transport,
      cacheStore: store,
      sendThrottle: new SendThrottle({
        minIntervalMs: 0,
        maxAttempts: 2,
        rateLimitDelayMs: 3_000,
        jitterRatio: 0,
        now: () => 0,
        random: () => 0.5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    });

    await expect(client.sendGroupMessage("g1", "hello", "m1")).resolves.toEqual({
      id: "mid",
    });
    expect(transport.calls).toHaveLength(2);
    expect(sleeps).toEqual([3_000]);
  });

  it("survives a process restart without refetching the token or gateway url", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-bot-cache-"));
    try {
      const file = join(dir, "cache.json");

      const firstTransport = new FakeTransport([
        {
          statusCode: 200,
          jsonData: { access_token: "tok", expires_in: 7_200 },
          text: "",
        },
        { statusCode: 200, jsonData: { url: "wss://gw" }, text: "" },
        { statusCode: 200, jsonData: {}, text: "" },
      ]);
      const first = new QQOfficialClient("app", "secret", {
        transport: firstTransport,
        cacheStore: new FileBotCacheStore(file),
      });
      await first.getGatewayUrl();
      await first.recallGroupMessage("g1", "m1");
      expect(firstTransport.calls.map((call) => call.url)).toEqual([
        "https://bots.qq.com/app/getAppAccessToken",
        "https://api.bot.qq.com/gateway",
        "https://api.bot.qq.com/v2/groups/g1/messages/m1",
      ]);

      // 第二次构造模拟进程重启：不应再请求 token 与 /gateway
      const secondTransport = new FakeTransport([
        { statusCode: 200, jsonData: {}, text: "" },
      ]);
      const second = new QQOfficialClient("app", "secret", {
        transport: secondTransport,
        cacheStore: new FileBotCacheStore(file),
      });

      await expect(second.getGatewayUrl()).resolves.toBe("wss://gw");
      await second.recallGroupMessage("g1", "m1");

      expect(secondTransport.calls).toHaveLength(1);
      expect(secondTransport.calls[0]?.headers.Authorization).toBe("QQBot tok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
