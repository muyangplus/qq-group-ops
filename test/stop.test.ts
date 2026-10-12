import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEventGateway } from "../src/adapters/fakeEventGateway.js";
import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { loadSettings } from "../src/config.js";
import { attachGateway } from "../src/gatewayRunner.js";
import { createRuntime } from "../src/runtime.js";
import { StopService, parseStopDuration } from "../src/services/stop.js";

/**
 * 停机 / 静默（ADR-0070，用户 2026-10-12 提出）。
 *
 * 口径：`/stop` 停进程（不自启）；`/stop <时长|forever>` 静默（到点自动恢复 / `/start` 手动恢复）。
 * 静默期间**非超管的消息完全不处理**（不回复、不审核、不推送），群里一条都不发、私信只发给超管。
 */
describe("StopService（停机 / 静默状态）", () => {
  let dir: string;
  let file: string;
  let now: number;
  let stop: StopService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qqops-stop-test-"));
    file = join(dir, "stop-state.json");
    now = Date.parse("2026-10-12T12:00:00.000Z");
    stop = new StopService(file, () => now);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("时长解析：分钟 / 小时 / 天 / 纯数字 / forever，坏值如实报错", () => {
    expect(parseStopDuration("30m")).toEqual({ ok: true, ms: 30 * 60_000 });
    expect(parseStopDuration("45")).toEqual({ ok: true, ms: 45 * 60_000 });
    expect(parseStopDuration("2h")).toEqual({ ok: true, ms: 2 * 3_600_000 });
    expect(parseStopDuration("1d")).toEqual({ ok: true, ms: 86_400_000 });
    expect(parseStopDuration("  forever ")).toEqual({ ok: true, ms: null });
    expect(parseStopDuration("永久")).toEqual({ ok: true, ms: null });
    // 坏值：空 / 认不出 / 0 / 超上限（超上限提示改用 forever）
    expect(parseStopDuration("").ok).toBe(false);
    expect(parseStopDuration("一会儿").ok).toBe(false);
    expect(parseStopDuration("0m").ok).toBe(false);
    expect(parseStopDuration("90d").ok).toBe(false);
  });

  it("静默 → 到点自动恢复（只读判断，不需要定时器）", () => {
    expect(stop.silenced()).toBe(false);
    stop.silence({ untilMs: 60_000, by: "root" });
    expect(stop.silenced()).toBe(true);
    expect(stop.current()?.until).toBe("2026-10-12T12:01:00.000Z");

    now += 59_999;
    expect(stop.silenced()).toBe(true);
    now += 1; // 到点
    expect(stop.silenced()).toBe(false);
    expect(stop.current()).toBeUndefined();
  });

  it("永久静默：`until === null`，只有手动恢复才结束", () => {
    stop.silence({ untilMs: null, by: "root", reason: "突发 bug" });
    expect(stop.silenced()).toBe(true);
    expect(stop.current()?.until).toBeNull();

    now += 100 * 86_400_000; // 100 天后仍在静默
    expect(stop.silenced()).toBe(true);

    const previous = stop.resume("root");
    expect(previous?.until).toBeNull();
    expect(stop.silenced()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("落盘 + 只读加载：重启进程后仍然静默（`load()` 不写盘）", () => {
    stop.silence({ untilMs: 3_600_000, by: "root" });

    const restarted = new StopService(file, () => now);
    restarted.load();
    expect(restarted.silenced()).toBe(true);
    // `load()` 只读：文件仍在，且内容没被改写
    const before = readFileSync(file, "utf8");
    restarted.load();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("停机留痕：`markStopped` 写入、`clearStoppedMarker` 清掉（启动时用）", () => {
    const state = stop.markStopped({ by: "root", reason: "manual" });
    expect(state.kind).toBe("stopped");
    expect(stop.silenced()).toBe(false); // 留痕不是静默

    const restarted = new StopService(file, () => now);
    restarted.load();
    const cleared = restarted.clearStoppedMarker();
    expect(cleared?.setBy).toBe("root");
    expect(existsSync(file)).toBe(false);
    expect(restarted.clearStoppedMarker()).toBeUndefined();
  });

  it("状态文件坏了：当正常运行，不抛（诊断信息不能拦住启动）", () => {
    writeFileSync(file, "{不是 JSON", "utf8");
    const broken = new StopService(file, () => now);
    expect(() => broken.load()).not.toThrow();
    expect(broken.silenced()).toBe(false);
  });
});

describe("静默的两道闸门（ADR-0070）", () => {
  let dir: string;
  let runtime: ReturnType<typeof createRuntime>;
  let api: FakeQQOfficialAPI;
  let gateway: FakeEventGateway;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "qqops-stop-gate-"));
    runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "root" }), {
      stopStateFile: join(dir, "stop-state.json"),
    });
    api = runtime.api as FakeQQOfficialAPI;
    gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("出站守卫：静默时群聊一律不发、私信只发给超管", async () => {
    runtime.stop.silence({ untilMs: 60_000, by: "root" });
    const card = { markdown: "## 测试卡", text: "测试卡" };

    // 群聊：拦下（是「按策略不发」，不是发送失败）
    const group = await runtime.richMessages.sendToGroup("g1", card);
    expect(group.ok).toBe(true);
    expect(group.detail).toContain("静默");
    expect(api.sentMessages).toHaveLength(0);

    // 私信给非超管：拦下
    await runtime.richMessages.sendToUser("member", card);
    expect(api.sentPrivateMessages).toHaveLength(0);

    // 私信给超管：放行（否则没法 `/start` 恢复）
    const root = await runtime.richMessages.sendToUser("root", card);
    expect(root.mode).not.toBe("none");
    expect(api.sentPrivateMessages).toHaveLength(1);
  });

  it("事件闸门：非超管的事件一律不处理，超管仍可用 `/start` 恢复", async () => {
    // 运维指令和别的指令一样要求「已绑定 QQ 号」（`/bind` 本身豁免）—— 先绑上
    await runtime.identityMap.bindUser("root", "10004");
    runtime.stop.silence({ untilMs: 60_000, by: "root" });

    // 正常情况下这两条都会有回复：非超管的私信指令 + 群内指令
    await gateway.emit({
      type: "private_message",
      userId: "member",
      messageId: "m1",
      content: "/myperm",
    });
    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m2",
      content: "/test",
    });
    expect(api.sentPrivateMessages).toHaveLength(0);
    expect(api.sentMessages).toHaveLength(0);

    // 超管私信 `/start` → 恢复 + 回执
    await gateway.emit({
      type: "private_message",
      userId: "root",
      messageId: "m3",
      content: "/start",
    });
    expect(api.sentPrivateMessages.length).toBeGreaterThan(0);
    expect(runtime.stop.silenced()).toBe(false);

    // 恢复之后非超管又能正常用了
    await gateway.emit({
      type: "private_message",
      userId: "member",
      messageId: "m4",
      content: "/myperm",
    });
    expect(api.sentPrivateMessages.length).toBeGreaterThan(1);
  });
});
