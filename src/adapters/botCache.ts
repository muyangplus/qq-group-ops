import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getLogger } from "../core/logger.js";

const log = getLogger("bot-cache");

export interface BotCacheSnapshot {
  appId: string;
  accessToken?: string;
  /** access token 过期时间（epoch 毫秒）。 */
  accessTokenExpiresAt?: number;
  gatewayUrl?: string;
}

export interface BotCacheStore {
  load(appId: string): Promise<BotCacheSnapshot | null>;
  save(snapshot: BotCacheSnapshot): Promise<void>;
}

/** 内存实现，用于测试与纯内存模式。 */
export class MemoryBotCacheStore implements BotCacheStore {
  private snapshot: BotCacheSnapshot | undefined;

  public async load(appId: string): Promise<BotCacheSnapshot | null> {
    if (!this.snapshot || this.snapshot.appId !== appId) {
      return null;
    }
    return { ...this.snapshot };
  }

  public async save(snapshot: BotCacheSnapshot): Promise<void> {
    this.snapshot = { ...snapshot };
  }
}

/**
 * 磁盘缓存，用于跨进程重启复用 access token 与网关地址。
 *
 * 注意：文件包含 access token，属于机密信息，写入时使用 0600 权限，且不应提交到 Git。
 */
export class FileBotCacheStore implements BotCacheStore {
  public constructor(private readonly filePath: string) {}

  public async load(appId: string): Promise<BotCacheSnapshot | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        log.warn("failed to read bot cache", {
          file: this.filePath,
          error: formatError(error),
        });
      }
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || parsed.appId !== appId) {
        return null;
      }
      return normalizeSnapshot(parsed, appId);
    } catch (error) {
      log.warn("failed to parse bot cache", {
        file: this.filePath,
        error: formatError(error),
      });
      return null;
    }
  }

  public async save(snapshot: BotCacheSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeSnapshot(
  value: Record<string, unknown>,
  appId: string,
): BotCacheSnapshot {
  const snapshot: BotCacheSnapshot = { appId };
  if (typeof value.accessToken === "string" && value.accessToken.length > 0) {
    snapshot.accessToken = value.accessToken;
  }
  if (
    typeof value.accessTokenExpiresAt === "number" &&
    Number.isFinite(value.accessTokenExpiresAt)
  ) {
    snapshot.accessTokenExpiresAt = value.accessTokenExpiresAt;
  }
  if (typeof value.gatewayUrl === "string" && value.gatewayUrl.length > 0) {
    snapshot.gatewayUrl = value.gatewayUrl;
  }
  return snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
