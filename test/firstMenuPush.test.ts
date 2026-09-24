import { describe, expect, it } from "vitest";

import type { MenuDeliveryRepository } from "../src/db/menuDeliveryRepository.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import {
  MemoryFirstMenuPushState,
  PersistentFirstMenuPushState,
} from "../src/services/firstMenuPush.js";

class FakeMenuDeliveryRepository implements MenuDeliveryRepository {
  public readonly pushed = new Map<string, string>();

  public async findAll(): Promise<string[]> {
    return [...this.pushed.keys()].sort();
  }

  public async markPushed(userId: string, pushedAt: string): Promise<void> {
    this.pushed.set(userId, pushedAt);
  }
}

describe("first menu push state", () => {
  it("claims the first push only once in memory", async () => {
    const state = new MemoryFirstMenuPushState();
    await state.load();

    expect(state.claim("u1")).toBe(true);
    expect(state.claim("u1")).toBe(false);
    expect(state.claim("u2")).toBe(true);
  });

  it("persists the claim and keeps it across a restart", async () => {
    const repository = new FakeMenuDeliveryRepository();
    const state = new PersistentFirstMenuPushState(repository, new WriteQueue());
    await state.load();

    expect(state.claim("u1")).toBe(true);
    await state.flush();
    expect(repository.pushed.has("u1")).toBe(true);

    // 模拟重启：新实例载入后不再重复推送
    const restarted = new PersistentFirstMenuPushState(
      repository,
      new WriteQueue(),
    );
    await restarted.load();
    expect(restarted.claim("u1")).toBe(false);
    expect(restarted.claim("u2")).toBe(true);
  });
});
