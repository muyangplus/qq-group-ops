import { describe, expect, it } from "vitest";

import {
  describeListenFailure,
  isAddressInUse,
} from "../src/adminApi/listenFailure.js";

/**
 * 两个管理 API 入口抢同一个端口时的提示（E1-d 收尾）。
 *
 * 场景：机器人进程内的监听口（读写）与 `pnpm admin:api` 只读巡检进程都用
 * `ADMIN_API_HOST:ADMIN_API_PORT`（默认 127.0.0.1:8787），后起的必然 EADDRINUSE。
 * 提示必须说清「谁在服务、写操作还能不能用」，否则运维只看到一句报错、不知道写端点其实已经 503。
 */
describe("监听失败提示", () => {
  it("识别 EADDRINUSE：code 或 message 两种形态", () => {
    expect(isAddressInUse(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isAddressInUse(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787"))).toBe(true);
    expect(isAddressInUse(new Error("listen EACCES: permission denied"))).toBe(false);
    expect(isAddressInUse("随便一个字符串")).toBe(false);
  });

  it("巡检进程占着端口时：明确写出「写端点会 503」", () => {
    const hint = describeListenFailure({
      error: Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
      host: "127.0.0.1",
      port: 8787,
      who: "in-process",
    });

    expect(hint).toContain("127.0.0.1:8787");
    expect(hint).toContain("只读巡检进程");
    expect(hint).toContain("503");
    expect(hint).toContain("ADMIN_API_PORT");
  });

  it("机器人监听口占着端口时：说明「巡检只是只读排查」", () => {
    const hint = describeListenFailure({
      error: new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787"),
      host: "127.0.0.1",
      port: 8787,
      who: "inspect",
    });

    expect(hint).toContain("机器人进程内的那个监听口");
    expect(hint).toContain("读写");
  });

  it("不是端口占用（权限 / 地址非法）时给通用排查方向", () => {
    const hint = describeListenFailure({
      error: Object.assign(new Error("listen EACCES: permission denied"), {
        code: "EACCES",
      }),
      host: "0.0.0.0",
      port: 80,
      who: "inspect",
    });

    expect(hint).toContain("EACCES");
    expect(hint).toContain("ADMIN_API_HOST");
    expect(hint).not.toContain("EADDRINUSE");
  });
});
