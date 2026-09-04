/**
 * Guards the service-worker caching policy: the worker may serve only
 * same-origin GETs for emitted asset paths from its cache. Navigations,
 * unknown assets, `/api`, `/proxy`, `/mcp`, POSTs, and cross-origin requests
 * must never be intercepted — Valet serves authenticated, real-time content,
 * and none of it may enter a service-worker cache.
 *
 * The tests run the real emitted worker source (template + build stamp from
 * `vite-plugin.ts`) inside a mock service-worker global scope.
 */
import { describe, expect, it, vi } from "vitest";
import { buildServiceWorkerSource } from "./vite-plugin";

const ORIGIN = "https://valet.example";

type Listener = (event: unknown) => void;

function createWorker(
  assetNames = ["assets/app-abc123.js"],
  cacheFailure?: "open" | "match" | "put",
) {
  const listeners = new Map<string, Listener[]>();
  const cacheStores = new Map<string, Map<string, Response>>();
  const deletedCaches: string[] = [];
  const warnMock = vi.fn();

  const caches = {
    keys: async () => [...cacheStores.keys()],
    delete: async (name: string) => {
      deletedCaches.push(name);
      return cacheStores.delete(name);
    },
    open: async (name: string) => {
      if (cacheFailure === "open") throw new Error("cache open failed");
      let store = cacheStores.get(name);
      if (!store) {
        store = new Map();
        cacheStores.set(name, store);
      }
      const entries = store;
      return {
        match: async (request: Request) => {
          if (cacheFailure === "match") throw new Error("cache match failed");
          return entries.get(request.url);
        },
        put: async (request: Request, response: Response) => {
          if (cacheFailure === "put") throw new Error("cache put failed");
          entries.set(request.url, response);
        },
      };
    },
  };

  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    addEventListener: (type: string, fn: Listener) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
  };

  const fetchMock = vi.fn(
    async (request: Request) => new Response(`network:${request.url}`, { status: 200 }),
  );

  new Function(
    "self",
    "caches",
    "fetch",
    "console",
    buildServiceWorkerSource(assetNames),
  )(self, caches, fetchMock, { warn: warnMock });

  async function dispatchFetch(request: Request): Promise<Response | undefined> {
    let responded: Promise<Response> | undefined;
    const event = {
      request,
      respondWith: (value: Response | Promise<Response>) => {
        responded = Promise.resolve(value);
      },
    };
    for (const fn of listeners.get("fetch") ?? []) fn(event);
    return responded;
  }

  async function dispatchActivate(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const event = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    for (const fn of listeners.get("activate") ?? []) fn(event);
    await Promise.all(pending);
  }

  return {
    listeners,
    cacheStores,
    deletedCaches,
    warnMock,
    self,
    fetchMock,
    dispatchFetch,
    dispatchActivate,
  };
}

describe("service worker template", () => {
  it("injects a normalized asset allowlist and derives the build id from it", () => {
    const normalizedSource = buildServiceWorkerSource([
      "manifest.webmanifest",
      "assets/b.css",
      "assets/a.js",
      "assets/b.css",
      "index.html",
    ]);
    const equivalentAllowlistSource = buildServiceWorkerSource([
      "assets/a.js",
      "assets/b.css",
      "ignored.txt",
    ]);
    const differentAllowlistSource = buildServiceWorkerSource(["assets/other.js"]);
    expect(normalizedSource).toBe(equivalentAllowlistSource);
    expect(normalizedSource).not.toBe(differentAllowlistSource);
    expect(normalizedSource).toContain('const BUILD_ID = "cccae63a3673";');
    expect(differentAllowlistSource).toContain('const BUILD_ID = "71c9fa813b94";');
    expect(normalizedSource).not.toMatch(/__[A-Z_]+__/);
    expect(normalizedSource).toContain(
      'const ASSET_PATHS = new Set(["/assets/a.js","/assets/b.css"]);',
    );
    expect(normalizedSource.match(/"\/assets\/a\.js"/g)).toHaveLength(1);
    expect(normalizedSource.match(/"\/assets\/b\.css"/g)).toHaveLength(1);
    expect(normalizedSource).not.toContain('"manifest.webmanifest"');
    expect(normalizedSource).not.toContain('"index.html"');
    expect(normalizedSource).not.toContain('"ignored.txt"');
  });

  it("registers activate and fetch handlers", () => {
    const worker = createWorker();
    expect([...worker.listeners.keys()].sort()).toEqual(["activate", "fetch"]);
  });

  it("activate: preserves the current build cache and does not claim clients", async () => {
    const worker = createWorker();
    const request = new Request(`${ORIGIN}/assets/app-abc123.js`);
    await worker.dispatchFetch(request);
    const [currentCacheName] = worker.cacheStores.keys();
    const currentCache = worker.cacheStores.get(currentCacheName);

    worker.cacheStores.set("valet-assets-oldbuild", new Map());
    worker.cacheStores.set("unrelated-cache", new Map());
    await worker.dispatchActivate();

    expect(worker.deletedCaches).toEqual(["valet-assets-oldbuild"]);
    expect(worker.cacheStores.get(currentCacheName)).toBe(currentCache);
    expect(currentCache?.size).toBe(1);
    expect(worker.cacheStores.has("unrelated-cache")).toBe(true);
    expect(worker.self.clients.claim).not.toHaveBeenCalled();
    expect(worker.listeners.has("install")).toBe(false);
  });

  it("serves an emitted asset path cache-first and caches the network response", async () => {
    const worker = createWorker();
    const request = new Request(`${ORIGIN}/assets/app-abc123.js`);
    const first = await worker.dispatchFetch(request);
    expect(await first?.text()).toBe(`network:${ORIGIN}/assets/app-abc123.js`);
    expect(worker.fetchMock).toHaveBeenCalledTimes(1);
    const second = await worker.dispatchFetch(request);
    expect(second).toBeDefined();
    expect(worker.fetchMock).toHaveBeenCalledTimes(1); // cache hit, no refetch
  });

  it("does not cache non-OK asset responses", async () => {
    const worker = createWorker(["assets/missing.js"]);
    worker.fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const request = new Request(`${ORIGIN}/assets/missing.js`);
    await worker.dispatchFetch(request);
    await worker.dispatchFetch(request);
    expect(worker.fetchMock).toHaveBeenCalledTimes(2); // 404 was not cached
  });

  it.each([
    [
      "an HTML response",
      () =>
        new Response("SPA fallback", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    ],
    [
      "a redirected response",
      () => {
        const response = new Response("redirected asset", { status: 200 });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    ],
  ])("returns but does not cache %s", async (_label, createResponse) => {
    const worker = createWorker();
    const firstNetworkResponse = createResponse();
    const secondNetworkResponse = createResponse();
    worker.fetchMock
      .mockResolvedValueOnce(firstNetworkResponse)
      .mockResolvedValueOnce(secondNetworkResponse);
    const request = new Request(`${ORIGIN}/assets/app-abc123.js`);

    const first = await worker.dispatchFetch(request);
    const second = await worker.dispatchFetch(request);

    expect(first).toBe(firstNetworkResponse);
    expect(second).toBe(secondNetworkResponse);
    expect(worker.fetchMock).toHaveBeenCalledTimes(2);
    expect(
      [...worker.cacheStores.values()].every((store) => store.size === 0),
    ).toBe(true);
  });

  it.each([
    ["open", "PWA cache read failed. Loading the asset from the network."],
    ["match", "PWA cache read failed. Loading the asset from the network."],
    ["put", "PWA cache write failed. Using the network response."],
  ] as const)(
    "uses the successful network response when cache %s fails",
    async (cacheFailure, warning) => {
      const worker = createWorker(["assets/app-abc123.js"], cacheFailure);
      const networkResponse = new Response("network asset", { status: 200 });
      worker.fetchMock.mockResolvedValueOnce(networkResponse);
      const request = new Request(`${ORIGIN}/assets/app-abc123.js`);

      const response = await worker.dispatchFetch(request);

      expect(response).toBe(networkResponse);
      expect(worker.fetchMock).toHaveBeenCalledTimes(1);
      expect(worker.warnMock).toHaveBeenCalledOnce();
      expect(worker.warnMock).toHaveBeenCalledWith(warning, expect.any(Error));
    },
  );

  it("does not intercept an unknown same-origin asset path", async () => {
    const worker = createWorker();
    const request = new Request(`${ORIGIN}/assets/unknown.js`);

    const response = await worker.dispatchFetch(request);

    expect(response).toBeUndefined();
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it("does not intercept a navigation with an allowlisted pathname", async () => {
    const worker = createWorker();
    const request = new Request(`${ORIGIN}/assets/app-abc123.js`);
    Object.defineProperty(request, "mode", { value: "navigate" });

    const response = await worker.dispatchFetch(request);

    expect(response).toBeUndefined();
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["navigation", new Request(`${ORIGIN}/`)],
    ["app route", new Request(`${ORIGIN}/sessions/abc`)],
    ["API", new Request(`${ORIGIN}/api/sessions`)],
    ["auth", new Request(`${ORIGIN}/api/auth/session`)],
    ["recording gateway", new Request(`${ORIGIN}/proxy/rec/x`)],
    ["MCP", new Request(`${ORIGIN}/mcp/tools`)],
    ["manifest", new Request(`${ORIGIN}/manifest.webmanifest`)],
    ["POST to assets path", new Request(`${ORIGIN}/assets/app.js`, { method: "POST" })],
    ["cross-origin asset", new Request("https://elsewhere.example/assets/app.js")],
  ])("never intercepts %s requests", async (_label, request) => {
    const worker = createWorker();
    const response = await worker.dispatchFetch(request);
    expect(response).toBeUndefined(); // no respondWith: browser default networking
    expect(worker.fetchMock).not.toHaveBeenCalled();
    expect([...worker.cacheStores.values()].every((store) => store.size === 0)).toBe(true);
  });
});
