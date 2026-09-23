import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileBotCacheStore,
  MemoryBotCacheStore,
} from "../src/adapters/botCache.js";

function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "qq-bot-cache-"));
  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("FileBotCacheStore", () => {
  it("persists and reloads access token and gateway url", async () => {
    await withTempDir(async (dir) => {
      const store = new FileBotCacheStore(join(dir, "nested", "cache.json"));
      const snapshot = {
        appId: "app",
        accessToken: "tok",
        accessTokenExpiresAt: 1_758_000_000_000,
        gatewayUrl: "wss://gateway.example/websocket",
      };

      await store.save(snapshot);

      await expect(store.load("app")).resolves.toEqual(snapshot);
    });
  });

  it("ignores a cache written for another app", async () => {
    await withTempDir(async (dir) => {
      const store = new FileBotCacheStore(join(dir, "cache.json"));
      await store.save({ appId: "other", accessToken: "tok" });

      await expect(store.load("app")).resolves.toBeNull();
    });
  });

  it("returns null for missing or corrupt files", async () => {
    await withTempDir(async (dir) => {
      const missing = new FileBotCacheStore(join(dir, "missing.json"));
      await expect(missing.load("app")).resolves.toBeNull();

      const corruptPath = join(dir, "corrupt.json");
      writeFileSync(corruptPath, "{ not json", "utf8");
      const corrupt = new FileBotCacheStore(corruptPath);
      await expect(corrupt.load("app")).resolves.toBeNull();
    });
  });

  it("drops unknown fields while loading", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "cache.json");
      writeFileSync(
        path,
        JSON.stringify({ appId: "app", accessToken: "tok", unexpected: 1 }),
        "utf8",
      );
      const store = new FileBotCacheStore(path);

      await expect(store.load("app")).resolves.toEqual({
        appId: "app",
        accessToken: "tok",
      });
    });
  });
});

describe("MemoryBotCacheStore", () => {
  it("round-trips snapshots and isolates apps", async () => {
    const store = new MemoryBotCacheStore();
    await store.save({ appId: "app", accessToken: "tok" });

    await expect(store.load("app")).resolves.toEqual({
      appId: "app",
      accessToken: "tok",
    });
    await expect(store.load("other")).resolves.toBeNull();
  });
});
