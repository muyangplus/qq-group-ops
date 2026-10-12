import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getLogger } from "../core/logger.js";

const log = getLogger("stop");

/**
 * 停机 / 静默状态文件（`data/stop-state.json`）。
 *
 * 为什么不放库：它是**进程级开关**（`/stop 30m`、`/stop forever`），而"库"要在连库之后才可用 ——
 * 静默必须能在启动早期就生效（甚至 `--check` 之前）。放进 `data/` 也天然随 `data/` 一起
 * 被保留（部署只替换 `dist/` `web/dist/` `scripts/`）。
 */
export const STOP_STATE_FILE = "data/stop-state.json";

/** `silence` = 静默中（到点自动恢复 / 永久等 `/start`）；`stopped` = 上次是被 `/stop` 停的（留痕）。 */
export type StopKind = "silence" | "stopped";

export interface StopState {
  kind: StopKind;
  /** 静默到什么时候（ISO）；`null` = 永久（要 `/start` 手动恢复）。`kind === "stopped"` 时不带。 */
  until?: string | null;
  /** 什么时候设置的（ISO）。 */
  setAt: string;
  /** 谁设置的（发起人的 openid / QQ号 / 短码，由指令层传入）。 */
  setBy: string;
  /** 一句话原因（可选）。 */
  reason?: string;
}

/** 静默时长上限（分钟）：更长就请用 `forever` + `/start`（避免"设了 3 年静默"这种手滑）。 */
export const STOP_MAX_MINUTES = 60 * 24 * 30;

/**
 * `/stop <时长>` 的解析：`30m` / `2h` / `1d` / `forever`（`永久` / `永远`）/ 纯数字 = 分钟。
 *
 * 返回 `ms === null` = 永久静默。
 */
export function parseStopDuration(
  raw: string,
): { ok: true; ms: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length === 0) {
    return {
      ok: false,
      error: "没写时长：用 `/stop 30m`（分钟 / 小时 / 天）或 `/stop forever`（永久，`/start` 恢复）。",
    };
  }
  if (/^(forever|永久|永远|无限)$/iu.test(text)) {
    return { ok: true, ms: null };
  }
  const bare = /^(\d+)$/u.exec(text);
  if (bare?.[1] !== undefined) {
    return minutesOf(Number(bare[1]));
  }
  const matched = /^(\d+)\s*(m|min|分钟|分|h|hour|hours|小时|时|d|day|days|天)$/iu.exec(text);
  if (!matched) {
    return {
      ok: false,
      error: `认不出时长「${raw}」：用 30m / 2h / 1d（或 forever）。`,
    };
  }
  const value = Number(matched[1]);
  const unit = (matched[2] ?? "").toLowerCase();
  if (unit.startsWith("h") || unit === "小时" || unit === "时") {
    return minutesOf(value * 60);
  }
  if (unit.startsWith("d") || unit === "天") {
    return minutesOf(value * 60 * 24);
  }
  return minutesOf(value);
}

/** 分钟 → 校验过的时长（负数 / 0 / 超上限都拒绝）。 */
function minutesOf(
  minutes: number,
): { ok: true; ms: number } | { ok: false; error: string } {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return { ok: false, error: "时长要是正整数（例如 `30m` / `2h` / `1d`）。" };
  }
  if (minutes > STOP_MAX_MINUTES) {
    return {
      ok: false,
      error: `最长 ${STOP_MAX_MINUTES / 60 / 24} 天；要停更久请用 \`/stop forever\`（之后 \`/start\` 恢复）。`,
    };
  }
  return { ok: true, ms: minutes * 60_000 };
}

/** 静默状态的展示文案（`2026-10-12 20:00` 或「永久」）。 */
export function describeStopUntil(state: StopState): string {
  if (state.kind === "stopped") {
    return "已停机";
  }
  if (state.until === null || state.until === undefined) {
    return "永久（直到 `/start`）";
  }
  return state.until;
}

function readStopState(file: string): StopState | undefined {
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== "silence" && kind !== "stopped") {
      return undefined;
    }
    const setAt = typeof record.setAt === "string" ? record.setAt : "";
    const setBy = typeof record.setBy === "string" ? record.setBy : "";
    if (setAt.length === 0 || setBy.length === 0) {
      return undefined;
    }
    const until =
      record.until === null
        ? null
        : typeof record.until === "string"
          ? record.until
          : undefined;
    return {
      kind,
      ...(kind === "silence" ? { until: until ?? new Date(setAt).toISOString() } : {}),
      setAt,
      setBy,
      ...(typeof record.reason === "string" && record.reason.length > 0
        ? { reason: record.reason }
        : {}),
    };
  } catch (error) {
    log.warn("stop state unreadable, treating as running", {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * 停机 / 静默状态（ADR-0070）。
 *
 * 语义：
 * - `silence`：**不许出站**（群聊一律不发、私信只发给平台超管），并且**非超管的事件一律不处理**；
 *   定时任务里会发消息的几项也停掉。到点自动恢复（只读判断，不需要定时器）；
 * - `stopped`：只是「上次是被 `/stop` 停的」留痕，供下次启动时诊断（启动时清掉）。
 *
 * ⚠️ `load()` **只读**（ADR-0069）：自检也会跑 `load()`，它不该写盘 ——
 * 「到点」由 `current()` 现算，「清留痕」由 `main.ts` 在自检早退之后调 `clearStoppedMarker()`。
 */
export class StopService {
  private state: StopState | undefined;

  public constructor(
    private readonly file: string = STOP_STATE_FILE,
    private readonly clock: () => number = Date.now,
  ) {}

  /** 只读加载（不写盘）。 */
  public load(): void {
    this.state = readStopState(this.file);
  }

  /** 当前生效的状态；静默已到点 → `undefined`（自动恢复）。 */
  public current(): StopState | undefined {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    if (
      state.kind === "silence" &&
      state.until !== null &&
      state.until !== undefined &&
      Number.isFinite(Date.parse(state.until)) &&
      Date.parse(state.until) <= this.clock()
    ) {
      return undefined;
    }
    return state;
  }

  /** 是否正在静默。 */
  public silenced(): boolean {
    return this.current()?.kind === "silence";
  }

  /** 进入静默；`untilMs === null` = 永久。 */
  public silence(input: {
    untilMs: number | null;
    by: string;
    reason?: string | undefined;
  }): StopState {
    const now = this.clock();
    const state: StopState = {
      kind: "silence",
      until:
        input.untilMs === null
          ? null
          : new Date(now + input.untilMs).toISOString(),
      setAt: new Date(now).toISOString(),
      setBy: input.by,
      ...(input.reason !== undefined && input.reason.length > 0
        ? { reason: input.reason }
        : {}),
    };
    this.state = state;
    this.persist(state);
    log.warn("silence started", {
      until: state.until ?? "forever",
      by: input.by,
    });
    return state;
  }

  /** 手动恢复（清状态 + 删文件）；返回被清掉的状态。 */
  public resume(by: string): StopState | undefined {
    const previous = this.state;
    this.state = undefined;
    this.removeFile();
    if (previous) {
      log.warn("silence cleared", {
        by,
        wasUntil: previous.until ?? "forever",
      });
    }
    return previous;
  }

  /** 记一笔「被 `/stop` 停机」（进程退出前写，供下次启动诊断）。 */
  public markStopped(input: { by: string; reason?: string | undefined }): StopState {
    const state: StopState = {
      kind: "stopped",
      setAt: new Date(this.clock()).toISOString(),
      setBy: input.by,
      ...(input.reason !== undefined && input.reason.length > 0
        ? { reason: input.reason }
        : {}),
    };
    this.state = state;
    this.persist(state);
    return state;
  }

  /** 启动时把上次的 `stopped` 留痕清掉；返回它（调用方据此记一条日志）。 */
  public clearStoppedMarker(): StopState | undefined {
    const state = this.state;
    if (state?.kind !== "stopped") {
      return undefined;
    }
    this.state = undefined;
    this.removeFile();
    return state;
  }

  private persist(state: StopState): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } catch (error) {
      log.warn("stop state write failed", {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private removeFile(): void {
    try {
      rmSync(this.file, { force: true });
    } catch (error) {
      log.warn("stop state remove failed", {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * `/stop`（立即停机）的钩子：`main.ts` 注入（命令层不直接杀进程）。
 *
 * 没装配时命令层明确拒绝 —— 直接 `node dist/main.js` 起、又没有进程管理器时，
 * 杀掉就再也起不来了（与 `/restart` 同一条边界）。
 */
export interface StopHook {
  readonly available: boolean;
  /** 请求停机；返回是否受理（受理后本进程会优雅退出，**不自启**）。 */
  request(info: { requestedBy: string; reason?: string | undefined }): boolean;
}
