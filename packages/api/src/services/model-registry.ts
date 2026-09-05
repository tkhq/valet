/**
 * Runtime model registry (TKAI-327) — the single source of model metadata
 * for the org catalog and for model resolution.
 *
 * ## Why this exists
 *
 * Valet's model list used to come from `getModels`/`getModel` on
 * `@earendil-works/pi-ai/compat`, which read a catalog baked into the
 * published pi-ai tarball at compile time. A model released today stayed
 * invisible until pi cut a release and Valet bumped the dependency. Those
 * two functions are marked `@deprecated Static catalog read`, and the
 * `/compat` module says it is temporary.
 *
 * This module reads the catalog at RUNTIME instead, and keeps the bundled
 * compile-time list as the floor.
 *
 * ## The shape of the solution
 *
 * pi-ai's `createModels()` + `createProvider()` already express exactly the
 * merge this needs. `createProvider({ models, fetchModels })` holds
 * `models` as a static baseline and overlays whatever `fetchModels`
 * returns, matched by id. So:
 *
 *   - `models` is pi-ai's bundled catalog for that provider — the fallback.
 *   - `fetchModels` is Valet's upstream fetch — the fresh overlay.
 *
 * The fallback is therefore STRUCTURAL, not a catch block. A fetch that
 * throws, times out, 404s, or returns junk leaves the baseline in place,
 * because the overlay is only applied when `fetchModels` returns. pi-ai
 * also restores the persisted catalog from the `ModelsStore` BEFORE it
 * allows any network access, so a cold process serves cached models
 * immediately and refreshes behind that.
 *
 * ## Refresh and revalidation
 *
 * `refreshModelRegistry` runs on boot, on a timer, and on a cache miss. It
 * sends the stored `etag` as `If-None-Match` and the stored `lastModified`
 * as `If-Modified-Since`, so an unchanged catalog costs a 304 and no body.
 * `checkedAt` records the last completed check, which
 * `getModelRegistryStatus` surfaces so a silently-stuck catalog is visible
 * rather than merely absent.
 *
 * ## What this module does NOT change
 *
 * Model-id namespacing (`{providerKindOrRowId}/{modelId}`, bare means
 * anthropic) is untouched: this module answers "which models exist and what
 * are their properties", never "what is this model called in Valet".
 * Catalog and resolution both read THIS module, so they cannot disagree
 * about what exists.
 */
import {
  createModels,
  createProvider,
  type Api,
  type ApiKeyAuth,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import type { AppDb } from "../lib/drizzle.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { PgModelsStore } from "./models-store-pg.js";
import { parseLastModified, parseRemoteCatalog, type RegistryModel } from "./model-registry-parse.js";

/** The providers Valet reads a catalog for. These are exactly the kinds the
 * org catalog and the resolver understand (`services/model-catalog.ts`'s
 * known kinds plus openrouter). Adding one here is not enough to make it
 * selectable — the catalog's own kind lists govern that. */
export const REGISTRY_PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const;

export type RegistryProvider = (typeof REGISTRY_PROVIDERS)[number];

/** How often to re-check upstream. An unchanged catalog answers 304, so
 * this is cheap; the interval only bounds how stale a NEW model can be. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Upstream must answer inside this budget. A slow registry degrades to the
 * cached or bundled list rather than holding a catalog build open. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Base URL of the upstream registry. Each provider's catalog is read from
 * `{base}/{providerId}.json`, matching the layout pi-ai generates into
 * `providers/data/`. Unset means the runtime fetch is OFF and every read
 * answers from the bundled catalog, which is the correct default for a
 * deployment that has not chosen a registry to trust.
 */
export function modelRegistryUrl(): string | undefined {
  const raw = process.env.VALET_MODEL_REGISTRY_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

/** Manual models that pi has not released. Pi bundled entries win by id. */
const MANUAL_BUNDLED_MODELS: Partial<Record<RegistryProvider, RegistryModel[]>> = {
  openai: [
    // Source: generated openai.json at unreleased pi commit 17de82d7, after v0.85.0.
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
      },
      contextWindow: 272000,
      maxTokens: 128000,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true,
      },
    } satisfies Model<"openai-responses">,
  ],
};

/** The pi bundled catalog plus unreleased manual entries. */
function bundledModels(providerId: RegistryProvider): RegistryModel[] {
  const builtin = [...getBuiltinModels(providerId satisfies BuiltinProvider)];
  const manual = MANUAL_BUNDLED_MODELS[providerId];
  if (!manual) return builtin;
  const builtinIds = new Set(builtin.map((model) => model.id));
  return [...builtin, ...manual.filter((model) => !builtinIds.has(model.id))];
}

/** Last-refresh state for one provider, surfaced by `GET /api/models`
 * so an operator can see a stuck catalog instead of guessing. */
export interface ModelRegistryProviderStatus {
  providerId: RegistryProvider;
  /** How many models the live collection currently answers with. */
  modelCount: number;
  /** Epoch ms of the last COMPLETED upstream check, or null when the
   * registry has never been reached (fetch off, or every attempt failed). */
  checkedAt: number | null;
  /** True when the served list is the bundled compile-time catalog. */
  usingBundledFallback: boolean;
  /** Message from the last failed check. Null when the last check worked. */
  lastError: string | null;
}

export interface ModelRegistryStatus {
  /** False when `VALET_MODEL_REGISTRY_URL` is unset — the bundled catalog
   * is authoritative by configuration, not by failure. */
  remoteEnabled: boolean;
  providers: ModelRegistryProviderStatus[];
}

interface ProviderState {
  lastError: string | null;
  fetchedCount: number;
}

/**
 * Owns the pi-ai `Models` collection, its refresh timer, and the
 * degradation policy. One instance per api process; `setModelRegistry`
 * publishes it to the catalog and resolver.
 */
export class ModelRegistry {
  private readonly models: MutableModels;
  private readonly store: PgModelsStore;
  private readonly state = new Map<RegistryProvider, ProviderState>();
  private timer: SweepTimer | null = null;

  constructor(private readonly db: AppDb) {
    this.store = new PgModelsStore(db);
    this.models = createModels({ modelsStore: this.store });
    for (const providerId of REGISTRY_PROVIDERS) {
      this.state.set(providerId, { lastError: null, fetchedCount: 0 });
      this.models.setProvider(
        createProvider({
          id: providerId,
          // The bundled catalog. pi-ai keeps this as the baseline and
          // overlays fetched models by id, so this list is what remains
          // when the fetch fails, returns nothing, or never runs.
          models: bundledModels(providerId),
          // A catalog read is public metadata and needs no credential, but
          // pi-ai SKIPS the network phase of `refresh()` for a provider whose
          // auth does not resolve. Resolving unconditionally is what keeps
          // the zero-config path working: a deployment with no provider key
          // at all still refreshes its model list.
          auth: { apiKey: catalogAuth(providerId) },
          fetchModels: (context) => this.fetchProviderModels(providerId, context.signal),
          // Models are never streamed through this collection. Valet builds
          // its own per-turn calls in `services/model-resolution.ts`, which
          // reads metadata from here and streams via the engine. A stream
          // attempt is a programming error, so it fails loudly.
          api: {
            stream: () => {
              throw new Error("model-registry: this collection is metadata-only; stream via the engine");
            },
            streamSimple: () => {
              throw new Error("model-registry: this collection is metadata-only; stream via the engine");
            },
          },
        }),
      );
    }
  }

  /**
   * Fetch one provider's catalog from upstream.
   *
   * Every failure path returns the STORED catalog rather than an empty
   * list. `createProvider` persists whatever this resolves to, so returning
   * `[]` after a failed check would overwrite a good cached catalog and
   * throw away models an earlier refresh won. Returning the stored list
   * makes a failed check a no-op instead.
   *
   * When nothing valid is stored, the result IS empty. That is the correct
   * answer: an empty overlay leaves pi-ai's static baseline, the bundled
   * compile-time catalog, as what the collection serves. `PgModelsStore`
   * also refuses to overwrite a stored catalog with an empty one, so the
   * served list degrades stored, then bundled, and never to nothing.
   */
  private async fetchProviderModels(
    providerId: RegistryProvider,
    signal: AbortSignal,
  ): Promise<RegistryModel[]> {
    const state = this.state.get(providerId);
    const stored = await this.store.read(providerId);
    const keepStored = (): RegistryModel[] => (stored ? [...stored.models] : []);

    const base = modelRegistryUrl();
    if (!base) return keepStored();

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      // Conditional request: an unchanged catalog answers 304 with no body.
      if (stored?.etag) headers["if-none-match"] = stored.etag;
      else if (stored?.lastModified) headers["if-modified-since"] = new Date(stored.lastModified).toUTCString();

      const res = await fetch(`${base}/${providerId}.json`, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });

      if (res.status === 304) {
        // Unchanged. Re-stamp `checkedAt` so the status surface can tell
        // "verified fresh just now" from "never checked", and keep the
        // stored models and validators exactly as they are.
        if (stored) await this.store.write(providerId, { ...stored, checkedAt: Date.now() });
        if (state) {
          state.lastError = null;
          state.fetchedCount = stored?.models.length ?? 0;
        }
        return keepStored();
      }

      if (!res.ok) {
        this.recordError(providerId, `upstream returned HTTP ${res.status}`);
        return keepStored();
      }

      const parsed = parseRemoteCatalog(providerId, await res.json());
      if (parsed.length === 0) {
        this.recordError(providerId, "upstream catalog held no readable models");
        return keepStored();
      }

      // pi-ai persists `{ models, checkedAt }` itself after this returns.
      // Write the validators here so the next check can be conditional;
      // pi-ai's own write follows and keeps the models in step.
      await this.store.write(providerId, {
        models: parsed,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: parseLastModified(res.headers.get("last-modified")),
        checkedAt: Date.now(),
      });

      if (state) {
        state.lastError = null;
        state.fetchedCount = parsed.length;
      }
      return parsed;
    } catch (err) {
      this.recordError(providerId, err instanceof Error ? err.message : String(err));
      return keepStored();
    }
  }

  private recordError(providerId: RegistryProvider, message: string): void {
    const state = this.state.get(providerId);
    if (state) state.lastError = message;
    // Logged, never thrown: the caller keeps the bundled or cached list.
    console.warn(`model-registry: ${providerId} refresh failed (${message}); using the stored or bundled catalog`);
  }

  /** Every known model for one provider — fetched when a refresh has
   * landed, bundled otherwise. Never empty for a registry provider. */
  listModels(providerId: RegistryProvider): RegistryModel[] {
    const live = this.models.getModels(providerId);
    return live.length > 0 ? [...live] : bundledModels(providerId);
  }

  /** One model by provider and WIRE id, or undefined when the provider does
   * not know it. Replaces the deprecated `getModel` compat read. */
  getModel(providerId: RegistryProvider, modelId: string): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId) ?? bundledModels(providerId).find((m) => m.id === modelId);
  }

  /**
   * Re-check upstream for every provider. Errors are collected by pi-ai and
   * reported, never thrown — one failing provider does not stop the others.
   */
  async refresh(): Promise<void> {
    if (!modelRegistryUrl()) return;
    const result = await this.models.refresh({ providers: [...REGISTRY_PROVIDERS] });
    for (const [providerId, err] of result.errors) {
      console.warn(`model-registry: ${providerId} refresh error:`, err.message);
    }
  }

  /**
   * Restore persisted catalogs without touching the network, then refresh
   * in the background. Boot never waits on an upstream that may be down.
   */
  async start(): Promise<void> {
    // Cache-only pass: pi-ai reads the store and publishes it as the
    // current list, so a cold process serves the last known catalog at once.
    await this.models.refresh({ allowNetwork: false, providers: [...REGISTRY_PROVIDERS] });
    if (!modelRegistryUrl()) return;
    void this.refresh();
    this.timer = startSweepTimer("model-registry", REFRESH_INTERVAL_MS, () => this.refresh());
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }

  async status(): Promise<ModelRegistryStatus> {
    const providers: ModelRegistryProviderStatus[] = [];
    for (const providerId of REGISTRY_PROVIDERS) {
      const stored = await this.store.read(providerId);
      const state = this.state.get(providerId);
      const live = this.models.getModels(providerId);
      providers.push({
        providerId,
        modelCount: live.length > 0 ? live.length : bundledModels(providerId).length,
        checkedAt: stored?.checkedAt ?? null,
        usingBundledFallback: (state?.fetchedCount ?? 0) === 0,
        lastError: state?.lastError ?? null,
      });
    }
    return { remoteEnabled: modelRegistryUrl() !== undefined, providers };
  }
}

/**
 * Auth for a catalog-only provider.
 *
 * pi-ai requires a `ProviderAuth` on every provider and treats an
 * unresolvable one as "not configured", which makes `refresh()` skip the
 * network phase. A model catalog is public, so this resolver always
 * succeeds and reports an empty key. Nothing streams through this
 * collection (the `api` handlers throw), so the empty key never reaches a
 * provider call: turns get their real key from
 * `services/model-resolution.ts`, which is unchanged.
 */
function catalogAuth(providerId: RegistryProvider): ApiKeyAuth {
  return {
    name: `${providerId} catalog`,
    login: async () => ({ type: "api_key", key: "" }),
    resolve: async () => ({ auth: { apiKey: "" }, source: "public catalog" }),
  };
}

// ── Process-wide handle ────────────────────────────────────────────────────
//
// The catalog and the resolver are called from request handlers that have no
// registry argument to thread. A module-level handle keeps ONE collection per
// process, so both read the same list and cannot disagree about what exists.
// When it is unset (unit tests, CLI paths with no database), every read falls
// back to the bundled catalog — the same answer the code gave before this
// feature, so no caller has to special-case a missing registry.

let active: ModelRegistry | null = null;

export function setModelRegistry(registry: ModelRegistry | null): void {
  active = registry;
}

export function getModelRegistry(): ModelRegistry | null {
  return active;
}

/** Every known model for a provider. Falls back to the bundled catalog when
 * no registry is installed. This is the ONE read the catalog and the
 * resolver share. */
export function registryModels(providerId: RegistryProvider): RegistryModel[] {
  return active ? active.listModels(providerId) : bundledModels(providerId);
}

/** One model by provider and wire id, or undefined. Falls back to the
 * bundled catalog when no registry is installed. */
export function registryModelById(providerId: RegistryProvider, modelId: string): Model<Api> | undefined {
  if (active) return active.getModel(providerId, modelId);
  return bundledModels(providerId).find((m) => m.id === modelId);
}

export async function getModelRegistryStatus(): Promise<ModelRegistryStatus> {
  if (!active) {
    return {
      remoteEnabled: false,
      providers: REGISTRY_PROVIDERS.map((providerId) => ({
        providerId,
        modelCount: bundledModels(providerId).length,
        checkedAt: null,
        usingBundledFallback: true,
        lastError: null,
      })),
    };
  }
  return active.status();
}
