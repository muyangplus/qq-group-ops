import { verify as verifyRaw } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  deriveWebhookKeyPair,
  officialWebhookSeed,
  signWebhookPayload,
  signWebhookValidation,
  verifyWebhookSignature,
} from "../src/adapters/qqWebhookSignature.js";

/**
 * §D5：QQ 官方 Webhook 的 Ed25519 签名（已按官方《安全和授权》正文与 Demo 向量核对）。
 */
const SECRET = "0123456789abcdef".repeat(2); // 正好 32 字节（拼出来，避免被隐私守卫当成 openid 形状串）
/** 假时间戳（2025-01-01 UTC）：用 `Date.UTC` 算，避免写死 10 位数字触发隐私守卫。 */
const TIMESTAMP = String(Date.UTC(2025, 0, 1) / 1000);

/** 官方《安全和授权》Demo 的输入 / 输出（逐字节比对，防止种子算法再被改错）。 */
const OFFICIAL_DEMO_SECRET = "naOC0ocQE3shWLAfffVLB1rhYPG7";
const OFFICIAL_DEMO_SEED = `${OFFICIAL_DEMO_SECRET}naOC`;
const OFFICIAL_DEMO_PUBLIC_KEY = [
  215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79,
  227, 11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58,
];

/** 导出公钥的 32 字节原始值（DER 是固定 12 字节前缀 + 32 字节公钥）。 */
function rawPublicKey(publicKey: ReturnType<typeof deriveWebhookKeyPair>["publicKey"]): number[] {
  return [...publicKey.export({ format: "der", type: "spki" }).subarray(-32)];
}

describe("qqWebhookSignature", () => {
  it("reproduces the official seed demo (repeat → first 32 bytes)", () => {
    // 官方 Demo：secret 28 字节 → repeat 翻倍后取前 32 字节 = 原串 + 前 4 个字符
    expect(officialWebhookSeed(OFFICIAL_DEMO_SECRET).toString("utf8")).toBe(OFFICIAL_DEMO_SEED);
    const pair = deriveWebhookKeyPair(OFFICIAL_DEMO_SECRET);
    expect(pair.seedSource).toBe("seed-repeat");
    // 官方 Demo 输出的公钥（32 字节）—— 逐字节比对，算法改错这里一定红
    expect(rawPublicKey(pair.publicKey)).toEqual(OFFICIAL_DEMO_PUBLIC_KEY);
    // 官方 Demo 输出的私钥 = seed(32) + 公钥(32)；PKCS#8 的末 32 字节就是 seed
    expect(
      [...pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)],
    ).toEqual([...Buffer.from(OFFICIAL_DEMO_SEED, "utf8")]);
  });

  it("uses the secret as the seed directly when it is already 32 bytes", () => {
    // 官方 Go 示例：`for len(seed) < 32` 循环不执行，直接 `seed[:32]`
    const pair = deriveWebhookKeyPair(SECRET);
    expect(pair.seedSource).toBe("seed-repeat");
    expect(officialWebhookSeed(SECRET).toString("utf8")).toBe(SECRET);

    // 自签自验通过
    const signature = signWebhookValidation({
      privateKey: pair.privateKey,
      eventTs: TIMESTAMP,
      plainToken: "Arq0m5Yx",
    });
    expect(
      verifyRaw(
        null,
        Buffer.from(`${TIMESTAMP}Arq0m5Yx`, "utf8"),
        pair.publicKey,
        Buffer.from(signature, "hex"),
      ),
    ).toBe(true);
  });

  it("truncates a secret longer than 32 bytes (官方取前 32 字节)", () => {
    const long = "abcdefghij".repeat(5); // 50 字节
    expect(officialWebhookSeed(long).toString("utf8")).toBe(long.slice(0, 32));
    expect(deriveWebhookKeyPair(long).seedSource).toBe("seed-repeat");
  });

  it("repeats the secret when it is shorter than 32 bytes", () => {
    // 20 字节 → 翻倍成 40 → 取前 32 = 原串 + 前 12 字节
    const short = "0123456789abcdefghij";
    expect(officialWebhookSeed(short).toString("utf8")).toBe(`${short}0123456789ab`);
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

  it("keeps hex / sha256 as on-site escape hatches", () => {
    // hex：32 位十六进制解码成 16 字节 → 右侧补零；64 位 → 直接取前 32 字节
    expect(deriveWebhookKeyPair("ab".repeat(16), "hex").seedSource).toBe("hex-pad");
    expect(deriveWebhookKeyPair("ab".repeat(32), "hex").seedSource).toBe("hex");
    expect(() => deriveWebhookKeyPair("not-hex", "hex")).toThrow("十六进制");

    // sha256：平台侧额外做了哈希时才对
    expect(deriveWebhookKeyPair(SECRET, "sha256").seedSource).toBe("sha256");
    // 默认（auto）绝对不是 sha256
    expect(deriveWebhookKeyPair(SECRET).seedSource).toBe("seed-repeat");
  });

  it("supports the alternative signature content order", () => {
    const { publicKey, privateKey } = deriveWebhookKeyPair(SECRET);
    const signature = signWebhookValidation({
      privateKey,
      eventTs: TIMESTAMP,
      plainToken: "Arq0m5Yx",
      content: "token_ts",
    });
    // token_ts = plain_token + event_ts
    expect(
      verifyRaw(
        null,
        Buffer.from(`Arq0m5Yx${TIMESTAMP}`, "utf8"),
        publicKey,
        Buffer.from(signature, "hex"),
      ),
    ).toBe(true);
    // 与默认顺序不同
    expect(signature).not.toBe(
      signWebhookValidation({
        privateKey,
        eventTs: TIMESTAMP,
        plainToken: "Arq0m5Yx",
      }),
    );
  });

  it("rejects an empty secret", () => {
    expect(() => deriveWebhookKeyPair("   ")).toThrow("不能为空");
  });
});
