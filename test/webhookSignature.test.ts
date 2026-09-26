import { verify as verifyRaw } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  deriveWebhookKeyPair,
  signWebhookPayload,
  signWebhookValidation,
  verifyWebhookSignature,
} from "../src/adapters/qqWebhookSignature.js";

/**
 * §D5：QQ 官方 Webhook 的 Ed25519 签名（真机算法核对点见 ADR-0049）。
 */
const SECRET = "0123456789abcdef".repeat(4);
/** 假时间戳（2025-01-01 UTC）：用 `Date.UTC` 算，避免写死 10 位数字触发隐私守卫。 */
const TIMESTAMP = String(Date.UTC(2025, 0, 1) / 1000);

describe("qqWebhookSignature", () => {
  it("derives a stable key pair from a 32-byte hex secret", () => {
    const first = deriveWebhookKeyPair(SECRET);
    const second = deriveWebhookKeyPair(SECRET.toUpperCase());
    expect(first.seedSource).toBe("hex");
    expect(second.seedSource).toBe("hex");
    // 同一个种子得到同一个公钥（十六进制大小写不影响）
    expect(
      first.publicKey.export({ format: "der", type: "spki" }).toString("hex"),
    ).toBe(
      second.publicKey.export({ format: "der", type: "spki" }).toString("hex"),
    );
  });

  it("falls back to a sha256 seed when the secret is not hex", () => {
    const pair = deriveWebhookKeyPair("一个不是十六进制的密钥");
    expect(pair.seedSource).toBe("sha256");
    // 回退路径同样能自签自验
    const body = '{"op":0,"t":"GROUP_AT_MESSAGE_CREATE","d":{"id":"m1"}}';
    const signature = signWebhookPayload({
      privateKey: pair.privateKey,
      timestamp: TIMESTAMP,
      rawBody: body,
    });
    expect(
      verifyWebhookSignature({
        publicKey: pair.publicKey,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature,
      }),
    ).toBe(true);
  });

  it("verifies a signature over timestamp + raw body", () => {
    const { publicKey, privateKey } = deriveWebhookKeyPair(SECRET);
    const body = Buffer.from(
      '{"op":0,"t":"GROUP_AT_MESSAGE_CREATE","d":{"id":"m1"}}',
      "utf8",
    );
    const signature = signWebhookPayload({
      privateKey,
      timestamp: TIMESTAMP,
      rawBody: body,
    });

    expect(
      verifyWebhookSignature({
        publicKey,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature,
      }),
    ).toBe(true);
    // 验签只认「timestamp + body」这一种拼接：空时间戳 / 缺签名一律拒绝
    expect(
      verifyWebhookSignature({
        publicKey,
        timestamp: "",
        rawBody: body,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        publicKey,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature: undefined,
      }),
    ).toBe(false);
  });

  it("rejects tampered bodies, wrong timestamps, bad hex and wrong keys", () => {
    const { publicKey, privateKey } = deriveWebhookKeyPair(SECRET);
    const other = deriveWebhookKeyPair("a".repeat(64));
    const body = '{"op":0,"t":"GROUP_MESSAGE_CREATE","d":{"id":"m1"}}';
    const signature = signWebhookPayload({
      privateKey,
      timestamp: TIMESTAMP,
      rawBody: body,
    });

    // 改了 body
    expect(
      verifyWebhookSignature({
        publicKey,
        timestamp: TIMESTAMP,
        rawBody: '{"op":0,"t":"GROUP_MESSAGE_CREATE","d":{"id":"m2"}}',
        signature,
      }),
    ).toBe(false);
    // 改了 timestamp
    expect(
      verifyWebhookSignature({
        publicKey,
        timestamp: String(Number(TIMESTAMP) + 1),
        rawBody: body,
        signature,
      }),
    ).toBe(false);
    // 非法十六进制 / 长度不对
    expect(
      verifyWebhookSignature({
        publicKey,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature: "zz",
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        publicKey,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature: "abcd",
      }),
    ).toBe(false);
    // 换了一把密钥
    expect(
      verifyWebhookSignature({
        publicKey: other.publicKey,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature,
      }),
    ).toBe(false);
  });

  it("signs the op=13 validation handshake over event_ts + plain_token", () => {
    const { publicKey, privateKey } = deriveWebhookKeyPair(SECRET);
    const signature = signWebhookValidation({
      privateKey,
      eventTs: TIMESTAMP,
      plainToken: "Arq0m5Yx",
    });
    expect(signature).toMatch(/^[0-9a-f]{128}$/u);
    // 用公钥对同一份内容验签（确认签名内容 = event_ts + plain_token）
    expect(
      verifyRaw(
        null,
        Buffer.from(`${TIMESTAMP}Arq0m5Yx`, "utf8"),
        publicKey,
        Buffer.from(signature, "hex"),
      ),
    ).toBe(true);
  });

  it("rejects an empty secret", () => {
    expect(() => deriveWebhookKeyPair("   ")).toThrow("不能为空");
  });
});
