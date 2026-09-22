import { describe, expect, it } from "vitest";

import { FetchTransport } from "../src/adapters/fetchTransport.js";

describe("FetchTransport", () => {
  it("sends JSON and parses JSON responses", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return {
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;

    const transport = new FetchTransport(fakeFetch, 1000);
    const response = await transport.request(
      "POST",
      "https://example.test",
      { "Content-Type": "application/json" },
      { a: 1 },
    );

    expect(response.statusCode).toBe(200);
    expect(response.jsonData).toEqual({ ok: true });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ a: 1 }));
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts requests on timeout", async () => {
    const fakeFetch = ((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as typeof fetch;

    const transport = new FetchTransport(fakeFetch, 5);

    await expect(
      transport.request("GET", "https://example.test", {}),
    ).rejects.toThrow(/aborted/u);
  });
});
