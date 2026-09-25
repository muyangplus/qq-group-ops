import { describe, expect, it } from "vitest";

import {
  PushService,
  startOfToday,
  type PushDeliveryRecord,
  type PushStore,
} from "../src/services/pushService.js";

interface Entry extends PushDeliveryRecord {
  key: string;
}

/** 内存投递表（与两个真实服务里的适配器同形）。 */
function makeStore(): PushStore<Entry> & { entries: Map<string, Entry> } {
  const entries = new Map<string, Entry>();
  return {
    entries,
    has: (key) => entries.has(key),
    countSince: (userId, since) =>
      [...entries.values()].filter((e) => e.userId === userId && e.createdAt >= since).length,
    record: (key, entry) => {
      entries.set(key, entry);
    },
  };
}

function makeService(store: PushStore<Entry>, extra: { dailyLimit?: number; recordOnFailure?: boolean } = {}) {
  const now = new Date("2024-03-05T10:00:00"); // 本地时间
  return new PushService<Entry>({
    store,
    now: () => now,
    label: "test push",
    ...(extra.dailyLimit !== undefined ? { dailyLimit: extra.dailyLimit } : {}),
    ...(extra.recordOnFailure !== undefined ? { recordOnFailure: extra.recordOnFailure } : {}),
  });
}

const entryOf = (key: string) => (userId: string) => (now: Date): Entry => ({ key, userId, createdAt: now });

describe("PushService", () => {
  it("投递成功后记录，重复投递按 key 跳过", async () => {
    const store = makeStore();
    const push = makeService(store);
    let sends = 0;
    const deliver = () =>
      push.deliver({
        key: "k1",
        userId: "u1",
        send: async () => {
          sends += 1;
          return { ok: true, detail: "sent" };
        },
        entry: entryOf("k1")("u1"),
      });

    expect((await deliver()).status).toBe("sent");
    expect(sends).toBe(1);
    expect(store.entries.has("k1")).toBe(true);

    const second = await deliver();
    expect(second.status).toBe("skipped");
    expect(second.detail).toBe("duplicate");
    expect(sends).toBe(1);
  });

  it("recordOnFailure 打开时失败也记录（不重复重试）", async () => {
    const store = makeStore();
    const push = makeService(store, { recordOnFailure: true });
    let sends = 0;
    const deliver = () =>
      push.deliver({
        key: "k2",
        userId: "u1",
        send: async () => {
          sends += 1;
          return { ok: false, detail: "no private chat" };
        },
        entry: entryOf("k2")("u1"),
      });

    expect((await deliver()).status).toBe("failed");
    expect(store.entries.has("k2")).toBe(true);
    expect((await deliver()).status).toBe("skipped");
    expect(sends).toBe(1);
  });

  it("默认失败不记录，允许下次重试", async () => {
    const store = makeStore();
    const push = makeService(store);
    let sends = 0;
    const deliver = () =>
      push.deliver({
        key: "k3",
        userId: "u1",
        send: async () => {
          sends += 1;
          return { ok: false, detail: "temporary" };
        },
        entry: entryOf("k3")("u1"),
      });

    expect((await deliver()).status).toBe("failed");
    expect(store.entries.size).toBe(0);
    await deliver();
    expect(sends).toBe(2);
  });

  it("按人每日封顶，返回 rateLimited 且不发送", async () => {
    const store = makeStore();
    const push = makeService(store, { dailyLimit: 2 });
    let sends = 0;
    const deliver = (key: string) =>
      push.deliver({
        key,
        userId: "u1",
        send: async () => {
          sends += 1;
          return { ok: true, detail: "sent" };
        },
        entry: entryOf(key)("u1"),
      });

    expect((await deliver("a")).status).toBe("sent");
    expect((await deliver("b")).status).toBe("sent");
    const third = await deliver("c");
    expect(third.status).toBe("rateLimited");
    expect(sends).toBe(2);

    // 别人不受影响
    const other = await push.deliver({
      key: "d",
      userId: "u2",
      send: async () => {
        sends += 1;
        return { ok: true, detail: "sent" };
      },
      entry: entryOf("d")("u2"),
    });
    expect(other.status).toBe("sent");
  });

  it("startOfToday 取本地 0 点", () => {
    const start = startOfToday(new Date(2024, 2, 5, 23, 59, 59));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2024, 2, 5]);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
  });

  it("桶空时等待下一个令牌，而不是丢消息", async () => {
    let fakeNow = 0;
    const sleeps: number[] = [];
    const store = makeStore();
    const push = new PushService<Entry>({
      store,
      now: () => new Date(fakeNow),
      label: "test push",
      rateLimitPerSecond: 2, // 桶容量 = ceil(2) = 2
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    });
    let sends = 0;
    const deliver = (key: string) =>
      push.deliver({
        key,
        userId: "u1",
        send: async () => {
          sends += 1;
          return { ok: true, detail: "sent" };
        },
        entry: entryOf(key)("u1"),
      });

    // 前两条用掉桶里的 2 个令牌，不等待
    expect((await deliver("r1")).status).toBe("sent");
    expect((await deliver("r2")).status).toBe("sent");
    expect(sleeps).toEqual([]);

    // 第三条桶空 → 等一个令牌（2/s ⇒ 500ms）后照常发出
    expect((await deliver("r3")).status).toBe("sent");
    expect(sleeps).toEqual([500]);
    expect(sends).toBe(3);
  });

  it("未配置速率时不节流", async () => {
    let fakeNow = 0;
    const sleeps: number[] = [];
    const store = makeStore();
    const push = new PushService<Entry>({
      store,
      now: () => new Date(fakeNow),
      label: "test push",
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    });
    for (const key of ["a", "b", "c"]) {
      const outcome = await push.deliver({
        key,
        userId: "u1",
        send: async () => ({ ok: true, detail: "sent" }),
        entry: entryOf(key)("u1"),
      });
      expect(outcome.status).toBe("sent");
    }
    expect(sleeps).toEqual([]);
  });
});
