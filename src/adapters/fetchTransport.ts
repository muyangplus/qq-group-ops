import type {
  AsyncTransport,
  HttpResponse,
  JsonValue,
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
    const response = await this.fetchImpl(url, init);
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
    };
  }

  public async aclose(): Promise<void> {
    return Promise.resolve();
  }
}
