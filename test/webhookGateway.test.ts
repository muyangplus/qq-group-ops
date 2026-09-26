import { describe, expect, it } from "vitest";

import { QQOfficialEventMapper } from "../src/adapters/qqOfficialEventMapper.js";
import {
  deriveWebhookKeyPair,
  signWebhookPayload,
  signWebhookValidation,
} from "../src/adapters/qqWebhookSignature.js";
import { WebhookEventGateway } from "../src/adapters/webhookEventGateway.js";
import type { QQEvent } from "../src/services/eventRouter.js";

/**
 * §D5：Webhook 事件通道（真机端口/路径由 EVENT_MODE=webhook + WEBHOOK_* 配置）。
 */
const SECRET = "0123456789abcdef".repeat(4);
const PATH = "/webhook/qq";
/** 假时间戳（2025-01-01 UTC）；用 `Date.UTC` 算，避免写死 10 位数字触发隐私守卫。 */
const TIMESTAMP = String(Date.UTC(2025, 0, 1) / 1000);

async function startGateway(): Promise<{
  gateway: WebhookEventGateway;
  events: QQEvent[];
  url: string;
  keyPair: ReturnType<typeof deriveWebhookKeyPair>;
  stop: () => Promise<void>;
}> {
  const keyPair = deriveWebhookKeyPair(SECRET);
  const events: QQEvent[] = [];
  const gateway = new WebhookEventGateway({
    secret: SECRET,
    port: 0,
    host: "127.0.0.1",
    path: PATH,
    mapper: new QQOfficialEventMapper(),
    keyPair,
  });
  await gateway.start((event) => {
    events.push(event);
  });
  const port = gateway.listeningPort;
  if (!port) {
    throw new Error("webhook gateway did not bind a port");
  }
  return {
    gateway,
    events,
    url: `http://127.0.0.1:${port}${PATH}`,
    keyPair,
    stop: async () => {
      await gateway.stop();
    },
  };
}

function signedRequest(
  url: string,
  keyPair: ReturnType<typeof deriveWebhookKeyPair>,
  payload: unknown,
  options: { timestamp?: string; signature?: string | null } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? TIMESTAMP;
  const signature =
    options.signature === null
      ? null
      : (options.signature ??
        signWebhookPayload({
          privateKey: keyPair.privateKey,
          timestamp,
          rawBody: body,
        }));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-signature-timestamp": timestamp,
  };
  if (signature !== null) {
    headers["x-signature-ed25519"] = signature;
  }
  return fetch(url, { method: "POST", headers, body });
}

describe("WebhookEventGateway", () => {
  it("answers the op=13 URL validation handshake with a valid signature", async () => {
    const harness = await startGateway();
    try {
      // 平台校验握手不带签名头
      const response = await fetch(harness.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: 13,
          d: { plain_token: "Arq0m5Yx", event_ts: TIMESTAMP },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        plain_token: string;
        signature: string;
      };
      expect(body.plain_token).toBe("Arq0m5Yx");
      expect(body.signature).toBe(
        signWebhookValidation({
          privateKey: harness.keyPair.privateKey,
          eventTs: TIMESTAMP,
          plainToken: "Arq0m5Yx",
        }),
      );
      // 校验握手不产生事件
      await harness.gateway.flush();
      expect(harness.events).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it("verifies the signature and dispatches a mapped event", async () => {
    const harness = await startGateway();
    try {
      const response = await signedRequest(harness.url, harness.keyPair, {
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        id: "e1",
        d: {
          id: "m1",
          group_openid: "g1",
          content: "<@!123456> /menu",
          author: { member_openid: "u1" },
        },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ op: 12 });

      await harness.gateway.flush();
      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]).toMatchObject({
        type: "group_message",
        groupId: "g1",
        userId: "u1",
        messageId: "m1",
        content: "/menu",
      });
    } finally {
      await harness.stop();
    }
  });

  it("rejects unsigned or tampered requests with 401 and never dispatches", async () => {
    const harness = await startGateway();
    try {
      const payload = {
        op: 0,
        t: "GROUP_MESSAGE_CREATE",
        d: {
          id: "m1",
          group_openid: "g1",
          content: "hello",
          author: { id: "u1" },
        },
      };
      // 完全没签名
      const unsigned = await signedRequest(harness.url, harness.keyPair, payload, {
        signature: null,
      });
      expect(unsigned.status).toBe(401);

      // 签名对但 body 被改
      const body = JSON.stringify(payload);
      const signature = signWebhookPayload({
        privateKey: harness.keyPair.privateKey,
        timestamp: TIMESTAMP,
        rawBody: body,
      });
      const tampered = await fetch(harness.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-timestamp": TIMESTAMP,
          "x-signature-ed25519": signature,
        },
        body: JSON.stringify({
          ...payload,
          d: { ...payload.d, content: "tampered" },
        }),
      });
      expect(tampered.status).toBe(401);

      // 时间戳被改（签名还是按原时间戳签的）
      const wrongTimestamp = await signedRequest(
        harness.url,
        harness.keyPair,
        payload,
        { timestamp: String(Number(TIMESTAMP) + 1), signature },
      );
      expect(wrongTimestamp.status).toBe(401);

      await harness.gateway.flush();
      expect(harness.events).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it("returns 400 for malformed payloads and ignores unknown ops", async () => {
    const harness = await startGateway();
    try {
      const badJson = await fetch(harness.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });
      expect(badJson.status).toBe(400);

      const missingFields = await fetch(harness.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: 13, d: { plain_token: "x" } }),
      });
      expect(missingFields.status).toBe(400);

      const unknownOp = await signedRequest(harness.url, harness.keyPair, {
        op: 99,
        t: "SOMETHING_NEW",
        d: {},
      });
      expect(unknownOp.status).toBe(200);
      await harness.gateway.flush();
      expect(harness.events).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it("keeps events in order and survives a failing handler", async () => {
    const keyPair = deriveWebhookKeyPair(SECRET);
    const handled: string[] = [];
    const gateway = new WebhookEventGateway({
      secret: SECRET,
      port: 0,
      host: "127.0.0.1",
      path: PATH,
      mapper: new QQOfficialEventMapper(),
      keyPair,
    });
    await gateway.start(async (event) => {
      const id = event.type === "group_message" ? event.messageId : event.type;
      handled.push(id);
      if (id === "m2") {
        throw new Error("handler blew up");
      }
    });
    const url = `http://127.0.0.1:${gateway.listeningPort}${PATH}`;
    try {
      for (const [id, content] of [
        ["m1", "one"],
        ["m2", "two"],
        ["m3", "three"],
      ] as const) {
        const response = await signedRequest(url, keyPair, {
          op: 0,
          t: "GROUP_MESSAGE_CREATE",
          d: { id, group_openid: "g1", content, author: { id: "u1" } },
        });
        expect(response.status).toBe(200);
      }
      await gateway.flush();
      // 第 2 条抛错不影响第 3 条，顺序保持
      expect(handled).toEqual(["m1", "m2", "m3"]);
      expect(gateway.pending).toBe(0);
    } finally {
      await gateway.stop();
    }
  });
});
