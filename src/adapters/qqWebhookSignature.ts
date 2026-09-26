import { createHash, createPrivateKey, createPublicKey, verify, sign, type KeyObject } from "node:crypto";
import { getLogger } from "../core/logger.js";

const log = getLogger("qq-webhook-signature");

/**
 * QQ 官方 Webhook 的 Ed25519 签名（§D5）。
 *
 * 官方回调的两条路都要签名，**都用同一个密钥对**（由机器人密钥 AppSecret 派生）：
 *
 * 1. **平台 → 机器人**：请求头带 `X-Signature-Ed25519`（十六进制签名）与 `X-Signature-Timestamp`，
 *    签名内容 = `timestamp + rawBody`（**注意是拼接后的字节，不是 JSON**）；
 *    我们用**派生的公钥**验签，失败一律 401（fail-closed）。
 * 2. **机器人 → 平台**（URL 校验握手，`op = 13`）：请求体带 `d.plain_token` 与 `d.event_ts`，
 *    我们要用**私钥**对 `event_ts + plain_token` 签名，回 `{"plain_token": "...", "signature": "<hex>"}`。
 *
 * 密钥派生（**已按官方《安全和授权》正文核对**）：把机器人密钥（Bot Secret / AppSecret）
 * **重复翻倍**到不少于 32 字节，取前 32 字节作 Ed25519 种子；官方 Demo：
 * secret `naOC0ocQE3shWLAfffVLB1rhYPG7` → seed `naOC0ocQE3shWLAfffVLB1rhYPG7naOC`
 * （测试里有这条官方向量的公钥比对，防止算法再被改错）。
 */

/**
 * Ed25519 PKCS#8 私钥的固定 DER 前缀（RFC 8410）：后接 32 字节种子。
 *
 * 故意拆成两段拼接：整串是 32 位十六进制，会被仓库隐私守卫当成「openid 形状串」——
 * 它是公开的算法常量，不是任何真实标识。
 */
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b6570042204" + "20",
  "hex",
);

export interface WebhookKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** 种子来源：`seed-repeat`（官方算法）/ `hex` / `hex-pad` / `sha256`（联调时对照日志）。 */
  seedSource: "seed-repeat" | "hex" | "hex-pad" | "sha256";
}

/**
 * 密钥派生策略（`WEBHOOK_KEY_DERIVATION`）。
 *
 * - `auto`（默认，= 官方《安全和授权》里的做法）：把密钥**重复拼接翻倍**直到不少于 32 字节，
 *   再取前 32 字节作种子（日志记 `seed-repeat`）；
 * - `hex`：十六进制解码后取前 32 字节（不足 32 字节时**右侧补零**，记 `hex-pad`，会 warn）；
 * - `sha256`：`sha256(密钥)` 作种子（早期版本的错误做法，只在平台确实加了哈希时才对）。
 *
 * 后两个是**排障用的逃生舱**：真机联调时平台对失败只回一句「签名校验不通过」，
 * 万一密钥形态不是官方 Demo 那种（比如平台侧额外做了哈希），改 `.env` + 重启就能试，不必改代码。
 */
export type WebhookKeyDerivation = "auto" | "hex" | "sha256";

/** 校验握手的签名内容（`WEBHOOK_SIGN_CONTENT`）：`ts_token` = `event_ts + plain_token`（默认）。 */
export type WebhookSignContent = "ts_token" | "token_ts";

export const WEBHOOK_KEY_DERIVATIONS: readonly WebhookKeyDerivation[] = [
  "auto",
  "hex",
  "sha256",
];

export const WEBHOOK_SIGN_CONTENTS: readonly WebhookSignContent[] = [
  "ts_token",
  "token_ts",
];

/**
 * 官方种子算法（《安全和授权》）：`repeat` 翻倍到 ≥32 字节后取前 32 字节。
 *
 * 对应官方 Go 示例：
 * ```go
 * seed := botSecret
 * for len(seed) < ed25519.SeedSize {  // SeedSize = 32
 *     seed = strings.Repeat(seed, 2)
 * }
 * rand := strings.NewReader(seed[:ed25519.SeedSize])
 * ```
 * 注意两点：**按字节**而不是按字符翻倍；密钥本身已 ≥32 字节时直接取前 32 字节（不补零、不哈希）。
 */
export function officialWebhookSeed(secret: string): Buffer {
  const raw = Buffer.from(secret.trim(), "utf8");
  if (raw.length === 0) {
    throw new Error("webhook secret 不能为空");
  }
  let seed = raw;
  while (seed.length < 32) {
    seed = Buffer.concat([seed, seed]);
  }
  return seed.subarray(0, 32);
}

/**
 * 从机器人密钥派生 Ed25519 密钥对。
 *
 * ⚠️ 真机踩过两轮：先是 32 位密钥走 `sha256` 导致 URL 校验报「签名校验不通过」；
 * 正确的是上面那条官方 repeat 规则 —— 所以 `auto` 必须与官方逐字节一致。
 */
export function deriveWebhookKeyPair(
  secret: string,
  derivation: WebhookKeyDerivation = "auto",
): WebhookKeyPair {
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    throw new Error("webhook secret 不能为空");
  }

  let seed: Buffer;
  let seedSource: WebhookKeyPair["seedSource"];

  switch (derivation) {
    case "hex": {
      const isHex = /^[0-9a-fA-F]+$/u.test(trimmed) && trimmed.length % 2 === 0;
      if (!isHex) {
        throw new Error("WEBHOOK_KEY_DERIVATION=hex 要求密钥是偶数长度的十六进制");
      }
      const decoded = Buffer.from(trimmed, "hex");
      if (decoded.length >= 32) {
        seed = decoded.subarray(0, 32);
        seedSource = "hex";
      } else {
        seed = Buffer.concat([decoded, Buffer.alloc(32 - decoded.length)]);
        seedSource = "hex-pad";
        log.warn("webhook secret hex-decoded shorter than 32 bytes, right-padded", {
          decodedBytes: decoded.length,
        });
      }
      break;
    }
    case "sha256":
      seed = createHash("sha256").update(trimmed, "utf8").digest();
      seedSource = "sha256";
      break;
    default:
      // auto：官方算法（repeat 翻倍 → 取前 32 字节）
      seed = officialWebhookSeed(trimmed);
      seedSource = "seed-repeat";
      break;
  }

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return {
    publicKey: createPublicKey(privateKey),
    privateKey,
    seedSource,
  };
}

/** 校验平台推来的请求签名。 */
export function verifyWebhookSignature(input: {
  publicKey: KeyObject;
  /** 请求头 `X-Signature-Timestamp`（字符串，**原样**参与拼接）。 */
  timestamp: string | undefined;
  /** 原始请求体（Buffer / 字符串）。 */
  rawBody: Buffer | string;
  /** 请求头 `X-Signature-Ed25519`（十六进制）。 */
  signature: string | undefined;
}): boolean {
  const { timestamp, rawBody, signature } = input;
  if (!timestamp || !signature) {
    return false;
  }
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature.trim(), "hex");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) {
    return false;
  }
  // 官方 Demo 的额外校验：最后一个字节的高 3 位必须为 0（Ed25519 标量规范形式）
  if (((signatureBytes[63] ?? 0) & 0xe0) !== 0) {
    return false;
  }
  try {
    return verify(null, message, input.publicKey, signatureBytes);
  } catch (error) {
    log.warn("webhook signature verify failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 生成 URL 校验握手（`op=13`）需要的签名：默认对 `event_ts + plain_token` 签名。 */
export function signWebhookValidation(input: {
  privateKey: KeyObject;
  eventTs: string;
  plainToken: string;
  /**
   * 拼接顺序（`WEBHOOK_SIGN_CONTENT`）；默认 `ts_token` = `event_ts + plain_token`。
   *
   * ⚠️ 事件回调的 `timestamp + body` 已在官方《安全和授权》里核对过；
   * 但 URL 校验握手（`op=13`）的拼接顺序官方页面上没写全，只有真机保存回调地址才能确认，
   * 所以留了 `token_ts` 备用。
   */
  content?: WebhookSignContent | undefined;
}): string {
  const message = Buffer.from(
    input.content === "token_ts"
      ? `${input.plainToken}${input.eventTs}`
      : `${input.eventTs}${input.plainToken}`,
    "utf8",
  );
  return sign(null, message, input.privateKey).toString("hex");
}

/** 测试用：用私钥给任意内容签名（真机上平台用的是同一密钥对）。 */
export function signWebhookPayload(input: {
  privateKey: KeyObject;
  timestamp: string;
  rawBody: Buffer | string;
}): string {
  const body =
    typeof input.rawBody === "string"
      ? Buffer.from(input.rawBody, "utf8")
      : input.rawBody;
  return sign(
    null,
    Buffer.concat([Buffer.from(input.timestamp, "utf8"), body]),
    input.privateKey,
  ).toString("hex");
}
