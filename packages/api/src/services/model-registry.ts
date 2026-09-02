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
 * Base URL of the upstream registry. pi operates the catalog service at
 * `https://pi.dev`, so that is the default: a deployment gets fresh model
 * metadata with no configuration, and the bundled catalog stays the floor.
 */
export const DEFAULT_MODEL_REGISTRY_URL = "https://pi.dev";

/**
 * The registry base URL, or `undefined` when the fetch is off.
 *
 * `VALET_MODEL_REGISTRY_URL` overrides the host. Set it to an EMPTY string
 * to turn the fetch off, which an air-gapped deployment needs. An UNSET
 * variable takes the default, so the zero-config path fetches.
 */
export function modelRegistryUrl(): string | undefined {
  const raw = process.env.VALET_MODEL_REGISTRY_URL;
  if (raw === undefined) return DEFAULT_MODEL_REGISTRY_URL;
  const trimmed = raw.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

/**
 * URL of one provider's catalog. pi serves each provider at
 * `/api/models/providers/{id}`. pi's own client for this service is
 * `withRemoteCatalog` in `packages/coding-agent/src/core/remote-catalog-provider.ts`;
 * the path here matches it, so a base URL that works for pi works here.
 */
export function providerCatalogUrl(base: string, providerId: string): string {
  return new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, base).toString();
}

/** The bundled compile-time catalog for one provider — the fallback floor.
 * `getBuiltinModels` is the non-deprecated read of the same generated table
 * the retired `getModels` used, so the fallback list is byte-identical to
 * the pre-TKAI-327 catalog. */
function bundledModels(providerId: RegistryProvider): RegistryModel[] {
  // `BuiltinProvider` is pi-ai's union of generated-catalog keys. Every id
  // in REGISTRY_PROVIDERS is one of them; the annotation states that at the
  // boundary instead of widening the helper's signature.
  return [...getBuiltinModels(providerId satisfies BuiltinProvider)];
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

      const res = await fetch(providerCatalogUrl(base, providerId), {
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

      // The registry has no catalog for this provider, and a later check
      // will not find one. Clear the validators so the entry stops sending
      // a conditional request against a body that never arrives. A
      // transient failure below keeps them, because there the cached body
      // is still valid and revalidation is the cheap path.
      if (res.status === 404 || res.status === 501) {
        await this.store.write(
          providerId,
          { models: [], checkedAt: Date.now() },
          { clearValidators: true },
        );
        this.recordError(providerId, `upstream has no catalog for this provider (HTTP ${res.status})`);
        return keepStored();
      }

      if (!res.ok) {
        // Transient: keep the cached body AND its validators, so the next
        // check revalidates instead of downloading the catalog again.
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
