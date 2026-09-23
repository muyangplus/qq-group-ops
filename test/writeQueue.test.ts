import { describe, expect, it } from "vitest";

import { WriteQueue } from "../src/db/writeQueue.js";

describe("WriteQueue", () => {
  it("runs tasks in enqueue order", async () => {
    const queue = new WriteQueue();
    const order: number[] = [];

    queue.enqueue("first", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(1);
    });
    queue.enqueue("second", async () => {
      order.push(2);
    });

    await queue.flush();

    expect(order).toEqual([1, 2]);
    expect(queue.pending).toBe(0);
  });

  it("isolates failures and keeps processing later writes", async () => {
    const queue = new WriteQueue();
    const done: string[] = [];

    queue.enqueue("broken", async () => {
      throw new Error("database unavailable");
    });
    queue.enqueue("healthy", async () => {
      done.push("healthy");
    });

    await queue.flush();

    expect(done).toEqual(["healthy"]);
    expect(queue.failures).toBe(1);
    expect(queue.lastError).toContain("database unavailable");
  });

  it("resolves immediately when nothing is queued", async () => {
    const queue = new WriteQueue();
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it("waits for tasks enqueued while flushing", async () => {
    const queue = new WriteQueue();
    const done: string[] = [];

    queue.enqueue("first", async () => {
      queue.enqueue("second", async () => {
        done.push("second");
      });
      done.push("first");
    });

    await queue.flush();

    expect(done).toEqual(["first", "second"]);
  });
});
