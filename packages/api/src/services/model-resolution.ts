/**
 * Catalog-aware model resolution — the api-side bridge that satisfies the
 * engine's host `resolveModel` seam (engine `ResolvedModel`, Task 1). Given a
 * namespaced model spec, it returns the live pi-ai `Model` to run a turn on
 * plus the API key to run it with, sourced from org LLM-provider config
 * (llm-providers design doc, plan Task 5):
 *
 *   - Known kinds (`anthropic`/`openai`/`google`/`openrouter`): the model comes from
 *     pi-ai's built-in registry (`getModel`); the key is the org credential at
 *     `llm:{rowId}` when a provider row + key exist, else pi-ai's env fallback
 *     (`getEnvApiKey`). With no row at all (zero-config boot) the env key still
 *     resolves the known kind — mirroring the catalog's zero-config synthesis.
 *   - Custom `openai_compatible` providers: the model is synthesized from the
 *     row's declared `models` entry; the key is the org credential ONLY — there
 *     is NO env fallback, so a missing key throws `provider {name} has no API
 *     key`.
 *
 * Canonical-id round-trip (Task 1 adversarial-review carry-forward 1, revised
 * with the openrouter extension): the engine persists `canonicalId` (the
 * caller's namespaced spec, echoed verbatim) and feeds it BACK to this
 * resolver at every turn start, so `resolve(resolve(spec).canonicalId)` MUST
 * be idempotent. The returned `model.id` is the provider-WIRE id (registry /
 * custom-entry id, e.g. `gpt-4.1`, `deepseek/deepseek-v4-pro`) — pi-ai sends
 * it verbatim as the request `model` parameter, so rewriting it to the
 * namespaced form (the pre-openrouter behavior) broke the actual provider
 * call for every namespaced spec. Bare Anthropic specs are the degenerate
 * case where wire id and canonical spec coincide.
 *
 * Return contract (mirrors the engine seam's `ResolvedModel | null`):
 *   - `null` — the spec is genuinely unknown (no such registry model). The
 *     engine's `setModel` turns this into the same "unknown model id" surface
 *     as its internal resolver.
 *   - throw `NoCredentialsError` (from @valet/engine, with the resolved model
 *     attached) — the spec resolves to a REAL model but no API key exists
 *     anywhere: known kind with neither an org key nor an env key, or a custom
 *     provider with no org key (custom has NO env fallback). The engine
 *     detects this at turn start and releases the claim back to `queued` for a
 *     bounded number of attempts; setModel-style validation accepts the spec
 *     via the attached model.
 *   - throw (plain Error) — the spec names a real provider that can't
 *     currently run it (disabled provider, deleted/unknown custom provider,
 *     model not active on a custom provider). These fail the turn the way
 *     model-resolution errors do today, with a clear message.
 */
import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai/compat";
import { NoCredentialsError, type CredentialOwner, type CredentialStore, type ResolvedModel } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import type { LlmProviderRow } from "../schema/index.js";
import { isKnownProviderKind, listLlmProviders, parseModelId, providerNamespace } from "./llm-providers.js";

/** The registry-backed kinds (narrower than `LlmProviderKind`). Note
 * `openrouter` model ids themselves contain slashes
 * (`deepseek/deepseek-v4-pro`), so a namespaced spec nests:
 * `openrouter/deepseek/deepseek-v4-pro`. `parseModelId` splits on the
 * FIRST slash only, so `modelId` keeps its inner slash and the registry
 * lookup + canonical-id round-trip both hold. Resolution deliberately
 * accepts ANY registry model — the curated selection on openrouter rows
 * (`services/openrouter.ts`) governs catalog/picker visibility only. */
type KnownKind = "anthropic" | "openai" | "google" | "openrouter";

function isKnownKindNamespace(ns: string): ns is KnownKind {
  return ns === "anthropic" || ns === "openai" || ns === "google" || ns === "openrouter";
}

/** Shared no-key message for the two registry-model credential-throw sites. */
function noKeyMessage(canonicalId: string): string {
  return `no usable API key for model "${canonicalId}" — configure an org LLM key or set the provider's API key env var`;
}

async function orgKey(credentials: CredentialStore, orgId: string, rowId: string): Promise<string | undefined> {
  const owner: CredentialOwner = { type: "org", id: orgId };
  const stored = await credentials.get(owner, `llm:${rowId}`);
  // Normalize empty/whitespace-only stored keys to "missing" so both the
  // known-kind branch (`=== undefined` check after the env fallback) and the
  // custom branch (`!apiKey`) treat empty ≡ absent uniformly — a blanked-out
  // credential must trigger NoCredentialsError ("has no API key"), never be
  // sent to a provider as a real key.
  const key = stored?.apiKey;
  return key !== undefined && key.trim() !== "" ? key : undefined;
}

/**
 * Registry lookup for a known kind. The returned model keeps its REGISTRY id
 * (`gpt-4.1`, `deepseek/deepseek-v4-pro`) — that's the wire id pi-ai sends
 * verbatim as the request `model` parameter, and a namespaced rewrite here
 * breaks the actual provider call (OpenRouter 400s on
 * `openrouter/vendor/model`; same class of failure for every namespaced
 * spec). Round-tripping is `ResolvedModel.canonicalId`'s job: the engine
 * persists/re-feeds the canonical spec, never the wire id.
 */
function registryModel(kind: KnownKind, modelId: string): Model<any> | null {
  // pi-ai's getModel is typed against its compile-time MODELS table; we accept
  // user-configurable ids and cast at the boundary (same idiom as the retired
  // hardcoded resolveModel). Runtime lookup is dynamic, so an unknown id yields
  // undefined rather than a type error. The engine accepts Model<any>.
  return getModel(kind as "anthropic", modelId as "claude-haiku-4-5") ?? null;
}

/** The canonical-id variant, used ONLY for `NoCredentialsError.model` — the
 * attached model exists so setModel-style validation can accept a keyless
 * spec, and its `id` doubles as the user-facing spec in error surfaces. It
 * never reaches a wire call (turn start re-resolves and throws again while
 * the key is still missing). */
function registryModelWithCanonicalId(kind: KnownKind, modelId: string, canonicalId: string): Model<any> | null {
  const model = registryModel(kind, modelId);
  if (!model) return null;
  return { ...model, id: canonicalId };
}

/**
 * Synthesize a `Model<"openai-completions">` for an openrouter-row
 * selection the pi-ai registry doesn't know (picked from OpenRouter's live
 * catalog). Wire id = the OpenRouter model id verbatim; metadata comes
 * from the stored row entry. Null when the id isn't in the row's selection
 * either — an arbitrary un-selected non-registry id stays unresolvable.
 */
function synthesizeOpenrouterModel(row: LlmProviderRow, modelId: string): Model<"openai-completions"> | null {
  const entry = row.models.find((m) => m.id === modelId);
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: entry.pricing
      ? { input: entry.pricing.input, output: entry.pricing.output, cacheRead: 0, cacheWrite: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? 128_000,
    maxTokens: 8192,
  };
}

/** Synthesize a `Model<"openai-completions">` for a custom provider's model
 * entry. `id` is the WIRE id (`entry.id`, what the upstream endpoint's
 * `model` parameter expects); round-tripping is carried by
 * `ResolvedModel.canonicalId` (`{rowId}/{modelId}`), not the model object. */
function synthesizeCustomModel(row: LlmProviderRow, modelId: string): Model<"openai-completions"> | null {
  const entry = row.models.find((m) => m.id === modelId);
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: row.id,
    baseUrl: row.baseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: entry.pricing
      ? { input: entry.pricing.input, output: entry.pricing.output, cacheRead: 0, cacheWrite: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? 128_000,
    maxTokens: 8192,
  };
}

/**
 * Resolve a namespaced model spec to `{ model, apiKey? }`, or `null` when the
 * spec is genuinely unknown. Throws for real-but-unusable providers (see the
 * module doc). `db` may be `undefined` (host builders without an app db, e.g.
 * tests): provider rows are then treated as empty, so known kinds still resolve
 * via env and custom specs throw as deleted/unknown.
 *
 * Keys are read fresh on every call — never cached — so a rotated org
 * credential takes effect on the very next turn.
 */
export async function resolveModelSpec(
  db: AppQueryable | undefined,
  credentials: CredentialStore,
  orgId: string,
  spec: string,
): Promise<ResolvedModel | null> {
  const { namespace, modelId } = parseModelId(spec);
  // Echo the caller's canonical form (bare stays bare, namespaced stays
  // namespaced) so the persisted id is idempotent under re-resolution.
  const canonicalId = spec.includes("/") ? `${namespace}/${modelId}` : modelId;
  const rows = db ? await listLlmProviders(db, orgId) : [];
  const row = rows.find((r) => providerNamespace(r) === namespace);

  if (row) {
    if (!row.enabled) throw new Error(`provider ${row.name} is disabled`);
    if (isKnownProviderKind(row.kind)) {
      // Guaranteed by isKnownProviderKind; narrow for the registry lookup.
      const kind = row.kind as KnownKind;
      // OpenRouter selections can name models newer than pi-ai's registry
      // snapshot (added from OpenRouter's live catalog in settings) —
      // synthesize those from the row's stored entry, same trust model as
      // custom providers' declared lists. Registry metadata wins when the
      // model IS known.
      const model =
        registryModel(kind, modelId) ??
        (kind === "openrouter" ? synthesizeOpenrouterModel(row, modelId) : null);
      if (!model) return null;
      const apiKey = (await orgKey(credentials, orgId, row.id)) ?? getEnvApiKey(kind);
      if (apiKey === undefined) {
        throw new NoCredentialsError(
          noKeyMessage(canonicalId),
          registryModelWithCanonicalId(kind, modelId, canonicalId) ?? model,
        );
      }
      return { model, apiKey, canonicalId };
    }
    // Custom (openai_compatible): org key only, no env fallback.
    const model = synthesizeCustomModel(row, modelId);
    if (!model) throw new Error(`model ${modelId} is not active on provider ${row.name}`);
    const apiKey = await orgKey(credentials, orgId, row.id);
    if (!apiKey) throw new NoCredentialsError(`provider ${row.name} has no API key`, { ...model, id: canonicalId });
    return { model, apiKey, canonicalId };
  }

  // No provider row for this namespace.
  if (isKnownKindNamespace(namespace)) {
    // Zero-config boot: registry model + env-key fallback. No env key means
    // no key ANYWHERE (there is no org row to hold one) — throw the explicit
    // credential signal so the engine's bounded pre-run release path handles
    // it instead of burning the turn on a keyless model call.
    const model = registryModel(namespace, modelId);
    if (!model) return null;
    const apiKey = getEnvApiKey(namespace);
    if (apiKey === undefined) {
      throw new NoCredentialsError(
        noKeyMessage(canonicalId),
        registryModelWithCanonicalId(namespace, modelId, canonicalId) ?? model,
      );
    }
    return { model, apiKey, canonicalId };
  }

  // A non-known namespace with no matching row is a deleted/unknown custom
  // provider — fail with a clear message rather than silently mis-resolving.
  throw new Error(`unknown or deleted provider: ${namespace}`);
}
