import { vi } from "vitest";

/**
 * 组件测试的**网络边界替身**（P2「前端组件测试底座」）。
 *
 * 只在 `fetch` 这一层造假：真实走 `api/client.ts` → `adminApi.*` → 组件的整条链路，
 * 所以「服务端形状变了、前端没跟着拆包」这类 bug 能被测出来（`notifyTopics` 就是这么漏的）。
 */
export interface StubbedCall {
  method: string;
  path: string;
  /** 请求体（已 JSON 解析）；GET 是 `undefined`。 */
  body: unknown;
  /** 是否带了 CSRF 头（写操作必须带）。 */
  csrf: boolean;
}

export interface FetchReply {
  status?: number;
  body?: unknown;
}

export interface FetchStub {
  calls: StubbedCall[];
  /** 按调用序号取第 n 次请求（越界给 `undefined`，断言里显式处理）。 */
  call(index: number): StubbedCall | undefined;
  restore(): void;
}

/** 装一个按 `path` / `method` 应答的假 `fetch`，并把调用记下来。 */
export function stubFetch(handler: (call: StubbedCall) => FetchReply): FetchStub {
  const calls: StubbedCall[] = [];
  const mock = vi.fn(
    async (
      path: unknown,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      const headers = init?.headers ?? {};
      const call: StubbedCall = {
        method: init?.method ?? "GET",
        path: String(path),
        body:
          typeof init?.body === "string" && init.body.length > 0
            ? (JSON.parse(init.body) as unknown)
            : undefined,
        csrf: headers["X-Admin-Request"] === "1",
      };
      calls.push(call);
      const reply = handler(call);
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async (): Promise<string> => JSON.stringify(reply.body ?? {}),
      } as Response;
    },
  );
  vi.stubGlobal("fetch", mock);
  return {
    calls,
    call: (index) => calls[index],
    restore: () => {
      vi.unstubAllGlobals();
    },
  };
}
