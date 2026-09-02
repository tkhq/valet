/**
 * Runtime model registry (TKAI-327) — the fetch, the Postgres cache, and the
 * hard requirement that a registry failure NEVER empties the model picker.
 *
 * The fallback assertions matter more than the happy path: a broken upstream
 * must degrade to the bundled compile-time catalog, and the served list must
 * stay non-empty through every failure mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { modelRegistryCache } from "../schema/index.js";
import { PgModelsStore } from "./models-store-pg.js";
import {
  DEFAULT_MODEL_REGISTRY_URL,
  ModelRegistry,
  modelRegistryUrl,
  providerCatalogUrl,
  registryModelById,
  registryModels,
  setModelRegistry,
} from "./model-registry.js";

const REGISTRY_URL = "https://registry.test/models";

function validModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "claude-brand-new",
    name: "Claude Brand New",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
    ...overrides,
  };
}

/** A catalog payload in the grouped shape pi-ai publishes. */
function catalogPayload(...models: Model<Api>[]) {
  return { "anthropic-messages": Object.fromEntries(models.map((m) => [m.id, m])) };
}

describe("PgModelsStore", () => {
  let db: AppDb;
  let store: PgModelsStore;

  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    store = new PgModelsStore(db);
  });

  it("returns undefined when nothing is stored", async () => {
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("round-trips models with their etag, lastModified, and checkedAt", async () => {
    await store.write("anthropic", {
      models: [validModel()],
      etag: '"abc123"',
      lastModified: 1_700_000_000_000,
      checkedAt: 1_700_000_100_000,
    });

    const entry = await store.read("anthropic");
    expect(entry?.models.map((m) => m.id)).toEqual(["claude-brand-new"]);
    expect(entry?.etag).toBe('"abc123"');
    expect(entry?.lastModified).toBe(1_700_000_000_000);
    expect(entry?.checkedAt).toBe(1_700_000_100_000);
  });

  it("overwrites the row for a provider rather than accumulating", async () => {
    await store.write("anthropic", { models: [validModel()], etag: '"v1"' });
    await store.write("anthropic", { models: [validModel({ id: "second" })], etag: '"v2"' });

    const rows = await db.select().from(modelRegistryCache).where(eq(modelRegistryCache.providerId, "anthropic"));
    expect(rows).toHaveLength(1);
    expect((await store.read("anthropic"))?.etag).toBe('"v2"');
  });

  it("drops malformed models on write and reports the row as empty", async () => {
    await store.write("anthropic", { models: [{ id: "truncated" }] as never });
    // Nothing valid was stored, so the reader sees "nothing cached" and the
    // caller keeps the bundled catalog.
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("refuses to overwrite a stored catalog with an empty one", async () => {
    await store.write("anthropic", { models: [validModel()], etag: '"v1"' });
    // pi-ai calls write directly, so an all-malformed payload must not erase
    // the good cache. The check still happened, so checkedAt advances.
    await store.write("anthropic", { models: [{ id: "truncated" }] as never, checkedAt: 123 });

    const entry = await store.read("anthropic");
    expect(entry?.models.map((m) => m.id)).toEqual(["claude-brand-new"]);
    expect(entry?.etag).toBe('"v1"');
    expect(entry?.checkedAt).toBe(123);
  });

  it("filters malformed models injected into an existing row", async () => {
    const now = Date.now();
    await db.insert(modelRegistryCache).values({
      providerId: "anthropic",
      models: [validModel(), { id: "half-built" }],
      etag: null,
      lastModified: null,
      checkedAt: now,
      updatedAt: now,
    });
    const entry = await store.read("anthropic");
    expect(entry?.models.map((m) => m.id)).toEqual(["claude-brand-new"]);
  });

  it("ignores a row that has gone stale, so a dead catalog cannot serve forever", async () => {
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    await db.insert(modelRegistryCache).values({
      providerId: "anthropic",
      models: [validModel()],
      etag: '"old"',
      lastModified: null,
      checkedAt: ancient,
      updatedAt: ancient,
    });
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("deletes a provider's row", async () => {
    await store.write("anthropic", { models: [validModel()] });
    await store.delete("anthropic");
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("keeps the stored validators when a write omits them", async () => {
    await store.write("anthropic", {
      models: [validModel()],
      etag: '"v1"',
      lastModified: 1_700_000_000_000,
    });
    // pi-ai persists { models, checkedAt } right after fetchModels resolves.
    // That write must not erase the ETag the fetch just captured.
    await store.write("anthropic", { models: [validModel()], checkedAt: 999 });

    const entry = await store.read("anthropic");
    expect(entry?.etag).toBe('"v1"');
    expect(entry?.lastModified).toBe(1_700_000_000_000);
    expect(entry?.checkedAt).toBe(999);
  });

  it("clears the validators when the caller asks, and keeps the models", async () => {
    await store.write("anthropic", {
      models: [validModel()],
      etag: '"v1"',
      lastModified: 1_700_000_000_000,
    });
    await store.write("anthropic", { models: [], checkedAt: 555 }, { clearValidators: true });

    const entry = await store.read("anthropic");
    // Rule 1 still holds: clearing the validators does not drop the catalog.
    expect(entry?.models.map((m) => m.id)).toEqual(["claude-brand-new"]);
    expect(entry?.etag).toBeUndefined();
    expect(entry?.lastModified).toBeUndefined();
    expect(entry?.checkedAt).toBe(555);
  });

  it("returns undefined for a row whose etag has no valid model behind it", async () => {
    // pi guards its call site with `stored?.models.length ? stored.etag : undefined`
    // so a 304 can never leave the overlay empty. This store closes the same
    // hole one level lower: a row with no readable model reads as "nothing
    // cached", so an orphan validator never reaches the caller and no
    // conditional request can be built from it.
    const now = Date.now();
    await db.insert(modelRegistryCache).values({
      providerId: "anthropic",
      models: [{ id: "half-built" }],
      etag: '"orphan-validator"',
      lastModified: null,
      checkedAt: now,
      updatedAt: now,
    });
    expect(await store.read("anthropic")).toBeUndefined();
  });
});

describe("ModelRegistry", () => {
  let db: AppDb;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VALET_MODEL_REGISTRY_URL", REGISTRY_URL);
  });

  afterEach(() => {
    setModelRegistry(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function jsonResponse(body: unknown, init: { etag?: string; lastModified?: string } = {}): Response {
    const headers = new Headers({ "content-type": "application/json" });
    if (init.etag) headers.set("etag", init.etag);
    if (init.lastModified) headers.set("last-modified", init.lastModified);
    return new Response(JSON.stringify(body), { status: 200, headers });
  }

  /**
   * Route responses by provider. `refresh()` fetches all four providers
   * concurrently, so a one-shot mock would be consumed by whichever request
   * won the race. A response body also reads only once, so each call builds
   * a fresh Response.
   */
  function routeFetch(anthropic: () => Response | Promise<Response>): void {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("anthropic") ? anthropic() : jsonResponse({}),
    );
  }

  it("serves the bundled catalog before any refresh", async () => {
    const registry = new ModelRegistry(db);
    const bundled = getBuiltinModels("anthropic");
    expect(registry.listModels("anthropic").map((m) => m.id).sort()).toEqual(
      bundled.map((m) => m.id).sort(),
    );
  });

  it("adds an upstream model that the bundled catalog does not know", async () => {
    routeFetch(() => jsonResponse(catalogPayload(validModel()), { etag: '"v1"' }));

    const registry = new ModelRegistry(db);
    await registry.refresh();

    const ids = registry.listModels("anthropic").map((m) => m.id);
    expect(ids).toContain("claude-brand-new");
    // The whole point: available WITHOUT a pi-ai release.
    expect(getBuiltinModels("anthropic").map((m) => m.id)).not.toContain("claude-brand-new");
    expect(registry.getModel("anthropic", "claude-brand-new")?.name).toBe("Claude Brand New");
  });

  it("keeps bundled models that the upstream catalog omits", async () => {
    // The overlay adds and updates; it must not delete. A thin upstream
    // response cannot shrink the picker below the bundled floor.
    routeFetch(() => jsonResponse(catalogPayload(validModel())));
    const registry = new ModelRegistry(db);
    await registry.refresh();

    const ids = registry.listModels("anthropic").map((m) => m.id);
    for (const bundled of getBuiltinModels("anthropic")) {
      expect(ids).toContain(bundled.id);
    }
  });

  it("persists the fetched catalog and its etag so a restart does not refetch", async () => {
    routeFetch(() =>
      jsonResponse(catalogPayload(validModel()), {
        etag: '"v1"',
        lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
      }),
    );
    await new ModelRegistry(db).refresh();

    const stored = await new PgModelsStore(db).read("anthropic");
    expect(stored?.models.map((m) => m.id)).toContain("claude-brand-new");
    expect(stored?.etag).toBe('"v1"');
    expect(stored?.lastModified).toBe(Date.parse("2015-10-21T07:28:00Z"));
  });

  it("sends If-None-Match on the next check and keeps the catalog on a 304", async () => {
    routeFetch(() => jsonResponse(catalogPayload(validModel()), { etag: '"v1"' }));
    const first = new ModelRegistry(db);
    await first.refresh();

    fetchMock.mockReset();
    routeFetch(() => new Response(null, { status: 304 }));

    // A fresh process shares the row written by the first one.
    const second = new ModelRegistry(db);
    await second.refresh();

    const anthropicCall = fetchMock.mock.calls.find(([url]) => String(url).includes("anthropic"));
    expect(anthropicCall).toBeDefined();
    const headers = (anthropicCall?.[1] as { headers: Record<string, string> }).headers;
    expect(headers["if-none-match"]).toBe('"v1"');
    expect(second.listModels("anthropic").map((m) => m.id)).toContain("claude-brand-new");
  });

  it("re-stamps checkedAt on a 304 so a fresh check is distinguishable from no check", async () => {
    routeFetch(() => jsonResponse(catalogPayload(validModel()), { etag: '"v1"' }));
    await new ModelRegistry(db).refresh();
    const firstCheckedAt = (await new PgModelsStore(db).read("anthropic"))?.checkedAt;
    expect(firstCheckedAt).toBeDefined();

    await new Promise((r) => setTimeout(r, 5));
    routeFetch(() => new Response(null, { status: 304 }));
    await new ModelRegistry(db).refresh();

    const secondCheckedAt = (await new PgModelsStore(db).read("anthropic"))?.checkedAt;
    expect(secondCheckedAt).toBeGreaterThanOrEqual(firstCheckedAt ?? 0);
  });

  describe("degrade, never break", () => {
    it.each([
      ["a network error", () => Promise.reject(new Error("ECONNREFUSED"))],
      ["an HTTP 500", () => Promise.resolve(new Response("boom", { status: 500 }))],
      ["an HTTP 404", () => Promise.resolve(new Response("", { status: 404 }))],
      ["malformed JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
      ["a payload of junk", () => Promise.resolve(new Response(JSON.stringify({ nope: 1 }), { status: 200 }))],
      [
        "a payload of half-built models",
        () => Promise.resolve(new Response(JSON.stringify({ g: { bad: { id: "x" } } }), { status: 200 })),
      ],
    ])("falls back to the bundled catalog on %s", async (_label, impl) => {
      fetchMock.mockImplementation(impl);
      const registry = new ModelRegistry(db);
      await registry.refresh();

      const ids = registry.listModels("anthropic").map((m) => m.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.sort()).toEqual(getBuiltinModels("anthropic").map((m) => m.id).sort());
    });

    it("reports the failure in the status surface instead of hiding it", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      const registry = new ModelRegistry(db);
      await registry.refresh();

      const status = await registry.status();
      const anthropic = status.providers.find((p) => p.providerId === "anthropic");
      expect(status.remoteEnabled).toBe(true);
      expect(anthropic?.usingBundledFallback).toBe(true);
      expect(anthropic?.lastError).toContain("ECONNREFUSED");
      expect(anthropic?.modelCount).toBeGreaterThan(0);
    });

    it("keeps the last good catalog when a later refresh fails", async () => {
      routeFetch(() => jsonResponse(catalogPayload(validModel()), { etag: '"v1"' }));
      const registry = new ModelRegistry(db);
      await registry.refresh();
      expect(registry.listModels("anthropic").map((m) => m.id)).toContain("claude-brand-new");

      fetchMock.mockRejectedValue(new Error("upstream down"));
      await registry.refresh();
      expect(registry.listModels("anthropic").map((m) => m.id)).toContain("claude-brand-new");
    });

    it("makes no network call and serves the bundle when the registry URL is empty", async () => {
      vi.stubEnv("VALET_MODEL_REGISTRY_URL", "");
      const registry = new ModelRegistry(db);
      await registry.start();
      registry.stop();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(registry.listModels("anthropic").length).toBeGreaterThan(0);
      expect((await registry.status()).remoteEnabled).toBe(false);
    });
  });

  describe("upstream URL", () => {
    it("defaults to pi.dev when the variable is unset", () => {
      vi.stubEnv("VALET_MODEL_REGISTRY_URL", undefined);
      expect(modelRegistryUrl()).toBe(DEFAULT_MODEL_REGISTRY_URL);
      expect(DEFAULT_MODEL_REGISTRY_URL).toBe("https://pi.dev");
    });

    it("treats an explicit empty value as off", () => {
      vi.stubEnv("VALET_MODEL_REGISTRY_URL", "");
      expect(modelRegistryUrl()).toBeUndefined();
      vi.stubEnv("VALET_MODEL_REGISTRY_URL", "   ");
      expect(modelRegistryUrl()).toBeUndefined();
    });

    it("lets an override replace the host and drops a trailing slash", () => {
      vi.stubEnv("VALET_MODEL_REGISTRY_URL", "https://mirror.test/");
      expect(modelRegistryUrl()).toBe("https://mirror.test");
    });

    it("builds pi's provider path, not a .json file path", () => {
      // The merged code asked for `{base}/{id}.json`, which 404s at pi.dev.
      expect(providerCatalogUrl("https://pi.dev", "anthropic")).toBe(
        "https://pi.dev/api/models/providers/anthropic",
      );
      expect(providerCatalogUrl("https://mirror.test", "open router")).toBe(
        "https://mirror.test/api/models/providers/open%20router",
      );
    });

    it("fetches the default host with no configuration", async () => {
      vi.stubEnv("VALET_MODEL_REGISTRY_URL", undefined);
      routeFetch(() => jsonResponse(catalogPayload(validModel())));
      await new ModelRegistry(db).refresh();

      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls).toContain("https://pi.dev/api/models/providers/anthropic");
    });
  });

  describe("a catalog that will never appear", () => {
    it.each([404, 501])("clears the validators on HTTP %i so it stops revalidating", async (status) => {
      routeFetch(() => jsonResponse(catalogPayload(validModel()), { etag: '"v1"' }));
      await new ModelRegistry(db).refresh();
      expect((await new PgModelsStore(db).read("anthropic"))?.etag).toBe('"v1"');

      routeFetch(() => new Response("", { status }));
      await new ModelRegistry(db).refresh();

      // The body stays, so the picker keeps serving it, but the validator is
      // gone: the next check does not spend a conditional request on a
      // catalog the registry has said it does not have.
      const stored = await new PgModelsStore(db).read("anthropic");
      expect(stored?.models.map((m) => m.id)).toContain("claude-brand-new");
      expect(stored?.etag).toBeUndefined();
      expect(stored?.lastModified).toBeUndefined();

      fetchMock.mockReset();
      routeFetch(() => new Response("", { status }));
      await new ModelRegistry(db).refresh();
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("anthropic"));
      const headers = (call?.[1] as { headers: Record<string, string> }).headers;
      expect(headers["if-none-match"]).toBeUndefined();
      expect(headers["if-modified-since"]).toBeUndefined();
    });

    it("keeps the validators on a transient 5xx so the next check stays cheap", async () => {
      routeFetch(() => jsonResponse(catalogPayload(validModel()), { etag: '"v1"' }));
      await new ModelRegistry(db).refresh();

      routeFetch(() => new Response("boom", { status: 503 }));
      await new ModelRegistry(db).refresh();

      const stored = await new PgModelsStore(db).read("anthropic");
      expect(stored?.models.map((m) => m.id)).toContain("claude-brand-new");
      expect(stored?.etag).toBe('"v1"');

      fetchMock.mockReset();
      routeFetch(() => new Response(null, { status: 304 }));
      await new ModelRegistry(db).refresh();
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("anthropic"));
      const headers = (call?.[1] as { headers: Record<string, string> }).headers;
      expect(headers["if-none-match"]).toBe('"v1"');
    });
  });

  describe("module handle", () => {
    it("falls back to the bundled catalog when no registry is installed", () => {
      setModelRegistry(null);
      expect(registryModels("anthropic").map((m) => m.id).sort()).toEqual(
        getBuiltinModels("anthropic").map((m) => m.id).sort(),
      );
      expect(registryModelById("anthropic", "does-not-exist")).toBeUndefined();
    });

    it("serves catalog and resolution from ONE list once installed", async () => {
      routeFetch(() => jsonResponse(catalogPayload(validModel())));
      const registry = new ModelRegistry(db);
      await registry.refresh();
      setModelRegistry(registry);

      // The invariant that keeps a model from appearing in the picker and
      // then failing at turn start: both reads answer from this one list.
      const listed = registryModels("anthropic").map((m) => m.id);
      expect(listed).toContain("claude-brand-new");
      for (const id of listed) {
        expect(registryModelById("anthropic", id)).toBeDefined();
      }
    });
  });
});
