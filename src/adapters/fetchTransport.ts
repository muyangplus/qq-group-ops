import type {
  AsyncTransport,
  HttpResponse,
  JsonValue,
  RawBody,
} from "./qqOfficial.js";

export class FetchTransport implements AsyncTransport {
  public constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  public async request(
    method: string,
    url: string,
    headers: Record<string, string>,
    json?: JsonValue,
  ): Promise<HttpResponse> {
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
    }
    return this.send(url, init);
  }

  /**
   * 直接发送二进制请求体（富媒体分片 `PUT` 到预签名 URL）。
   *
   * 预签名 URL 自带签名，调用方传入的 `headers` 为空，只补 `Content-Type`。
   */
  public async requestRaw(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: RawBody,
  ): Promise<HttpResponse> {
    return this.send(url, {
      method,
      headers: { ...headers, "Content-Type": body.contentType },
      // 原始字节：undici 接受 Uint8Array，但全局 `BodyInit` 类型未导出（只有 undici-types 有）。
      body: body.body as NonNullable<RequestInit["body"]>,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async send(url: string, init: RequestInit): Promise<HttpResponse> {
    const response = await this.fetchImpl(url, init);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    let jsonData: unknown = null;
    try {
      jsonData = await response.json();
    } catch {
      jsonData = null;
    }
    return {
      statusCode: response.status,
      jsonData,
      text: jsonData === null ? await response.text() : "",
      headers: responseHeaders,
    };
  }

  public async aclose(): Promise<void> {
    return Promise.resolve();
  }
}
