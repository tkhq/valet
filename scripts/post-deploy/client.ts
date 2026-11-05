/**
 * The post-deploy journeys' HTTP clients: one for the Valet public API (an
 * `x-api-key` credential, the surface the web app and CLI use) and one for
 * the GitHub REST API (the event journey's push).
 */

export class HttpError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} returned ${status}: ${body.slice(0, 400)}`);
  }

  /** The `error` field of a JSON error body, or the raw body. */
  get errorText(): string {
    try {
      const parsed: unknown = JSON.parse(this.body);
      if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") return parsed.error;
    } catch {
      // Not JSON: the raw body is the error.
    }
    return this.body;
  }
}

class JsonClient {
  readonly base: string;

  constructor(
    url: string,
    private readonly headers: Record<string, string>,
  ) {
    this.base = url.replace(/\/$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...this.headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(method, path, res.status, text);
    const value: unknown = text === "" ? null : JSON.parse(text);
    // The caller names the route's wire type (`packages/api/src/wire/types.ts`).
    return value as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, body);
  }
}

export class ApiClient extends JsonClient {
  constructor(url: string, apiKey: string) {
    super(url, { "x-api-key": apiKey });
  }
}

export class GitHubClient extends JsonClient {
  constructor(token: string) {
    super("https://api.github.com", {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "valet-post-deploy-journeys",
    });
  }
}
