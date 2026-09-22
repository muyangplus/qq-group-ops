import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENDPOINTS,
  QQOfficialAPIError,
  QQOfficialClient,
} from "../src/adapters/qqOfficial.js";
import type {
  AsyncTransport,
  HttpResponse,
  JsonValue,
} from "../src/adapters/qqOfficial.js";

interface CallRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  json?: JsonValue;
}

class FakeTransport implements AsyncTransport {
  public readonly calls: CallRecord[] = [];
  private readonly responses: HttpResponse[];

  public constructor(responses: HttpResponse[] = []) {
    this.responses = [...responses];
  }

  public async request(
    method: string,
    url: string,
    headers: Record<string, string>,
    json?: JsonValue,
  ): Promise<HttpResponse> {
    this.calls.push({ method, url, headers, json });
    return (
      this.responses.shift() ?? { statusCode: 200, jsonData: {}, text: "" }
    );
  }

  public async aclose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("QQOfficialClient", () => {
  it("fetches a token and sends a group message", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: { access_token: "tok" }, text: "" },
      { statusCode: 200, jsonData: { id: "mid" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", { transport });

    const result = await client.sendGroupMessage("g1", "hello", "m1");

    expect(result).toEqual({ id: "mid" });
    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toBe(
      "https://bots.qq.com/app/getAppAccessToken",
    );
    expect(transport.calls[0]?.json).toEqual({
      appId: "app",
      clientSecret: "secret",
    });
    expect(transport.calls[1]?.method).toBe("POST");
    expect(transport.calls[1]?.url).toContain("/v2/groups/g1/messages");
    expect(transport.calls[1]?.headers.Authorization).toBe("QQBot tok");
    expect(transport.calls[1]?.json).toEqual({
      content: "hello",
      msg_id: "m1",
    });
  });

  it("skips token fetch when token is provided", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.recallGroupMessage("g1", "m1");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.method).toBe("DELETE");
    expect(transport.calls[0]?.url).toContain("/v2/groups/g1/messages/m1");
  });

  it("approves join requests", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await client.approveJoinRequest("g1", "u1", true, "ok");

    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toContain(
      "/v2/groups/g1/approval_join_request/u1",
    );
    expect(transport.calls[0]?.json).toEqual({ approve: true, reason: "ok" });
  });

  it("reads join request lists", async () => {
    const transport = new FakeTransport([
      {
        statusCode: 200,
        jsonData: { data: [{ request_id: "r1" }] },
        text: "",
      },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await expect(client.getJoinRequests("g1")).resolves.toEqual([
      { request_id: "r1" },
    ]);
  });

  it("raises API errors", async () => {
    const transport = new FakeTransport([
      { statusCode: 403, jsonData: { message: "forbidden" }, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
    });

    await expect(client.getJoinRequests("g1")).rejects.toBeInstanceOf(
      QQOfficialAPIError,
    );
  });

  it("supports custom endpoints", async () => {
    const transport = new FakeTransport([
      { statusCode: 200, jsonData: {}, text: "" },
    ]);
    const client = new QQOfficialClient("app", "secret", {
      token: "tok",
      transport,
      endpoints: {
        ...DEFAULT_ENDPOINTS,
        baseUrl: "https://example.test",
        sendGroupMessage: "/custom/{groupId}/send",
      },
    });

    await client.sendGroupMessage("g1", "hello");

    expect(transport.calls[0]?.url).toBe("https://example.test/custom/g1/send");
  });
});
