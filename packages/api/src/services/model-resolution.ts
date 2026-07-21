/**
 * Catalog-aware model resolution — the api-side bridge that satisfies the
 * engine's host `resolveModel` seam (engine `ResolvedModel`, Task 1). Given a
 * namespaced model spec, it returns the live pi-ai `Model` to run a turn on
 * plus the API key to run it with, sourced from org LLM-provider config
 * (llm-providers design doc, plan Task 5):
 *
 *   - Known kinds (`anthropic`/`openai`/`google`): the model comes from
 *     pi-ai's built-in registry (`getModel`); the key is the org credential at
 *     `llm:{rowId}` when a provider row + key exist, else pi-ai's env fallback
 *     (`getEnvApiKey`). With no row at all (zero-config boot) the env key still
 *     resolves the known kind — mirroring the catalog's zero-config synthesis.
 *   - Custom `openai_compatible` providers: the model is synthesized from the
 *     row's declared `models` entry; the key is the org credential ONLY — there
 *     is NO env fallback, so a missing key throws `provider {name} has no API
 *     key`.
 *
 * Canonical-id round-trip (Task 1 adversarial-review carry-forward 1): the
 * engine persists the returned `model.id` and feeds it BACK to this resolver at
 * every turn start, so resolution MUST be idempotent on its own output. pi-ai
 * registry models carry bare canonical ids (`claude-haiku-4-5`, `gpt-x`) that
 * would round-trip ambiguously (a bare `gpt-x` reads as Anthropic under the
 * back-compat rule), so every returned model's `id` is rewritten to the FULL
 * namespaced form (`{namespace}/{modelId}`). `resolve(resolve(spec).model.id)`
 * then yields the same provider + key for anthropic, openai, and custom specs.
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
import { getEnvApiKey, getModel, type Model } from "@mariozechner/pi-ai";
import { NoCredentialsError, type CredentialOwner, type CredentialStore, type ResolvedModel } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import type { LlmProviderRow } from "../schema/index.js";
import { isKnownProviderKind, listLlmProviders, parseModelId, providerNamespace } from "./llm-providers.js";

/** The three registry-backed kinds (narrower than `LlmProviderKind`). */
type KnownKind = "anthropic" | "openai" | "google";

function isKnownKindNamespace(ns: string): ns is KnownKind {
  return ns === "anthropic" || ns === "openai" || ns === "google";
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
 * Registry model with its `id` rewritten to the caller's canonical spec so the
 * persisted id round-trips back to the same provider (carry-forward 1). A
 * namespaced input (`openai/gpt-x`) keeps its namespace — critical so a bare
 * `gpt-x` can never be re-read as Anthropic; a bare input (`claude-haiku-4-5`)
 * stays bare, since a bare id is Anthropic back-compat by definition and
 * re-resolves to Anthropic unambiguously.
 */
function registryModelWithCanonicalId(kind: KnownKind, modelId: string, canonicalId: string): Model<any> | null {
  // pi-ai's getModel is typed against its compile-time MODELS table; we accept
  // user-configurable ids and cast at the boundary (same idiom as the retired
  // hardcoded resolveModel). Runtime lookup is dynamic, so an unknown id yields
  // undefined rather than a type error. The engine accepts Model<any>.
  const model = getModel(kind as "anthropic", modelId as "claude-haiku-4-5");
  if (!model) return null;
  return { ...model, id: canonicalId };
}

/** Synthesize a `Model<"openai-completions">` for a custom provider's model
 * entry. `id` is the full namespaced spec so it round-trips (carry-forward 1). */
function synthesizeCustomModel(row: LlmProviderRow, modelId: string): Model<"openai-completions"> | null {
  const entry = row.models.find((m) => m.id === modelId);
  if (!entry) return null;
  return {
    id: `${row.id}/${entry.id}`,
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
      const model = registryModelWithCanonicalId(kind, modelId, canonicalId);
      if (!model) return null;
      const apiKey = (await orgKey(credentials, orgId, row.id)) ?? getEnvApiKey(kind);
      if (apiKey === undefined) throw new NoCredentialsError(noKeyMessage(canonicalId), model);
      return { model, apiKey };
    }
    // Custom (openai_compatible): org key only, no env fallback.
    const model = synthesizeCustomModel(row, modelId);
    if (!model) throw new Error(`model ${modelId} is not active on provider ${row.name}`);
    const apiKey = await orgKey(credentials, orgId, row.id);
    if (!apiKey) throw new NoCredentialsError(`provider ${row.name} has no API key`, model);
    return { model, apiKey };
  }

  // No provider row for this namespace.
  if (isKnownKindNamespace(namespace)) {
    // Zero-config boot: registry model + env-key fallback. No env key means
    // no key ANYWHERE (there is no org row to hold one) — throw the explicit
    // credential signal so the engine's bounded pre-run release path handles
    // it instead of burning the turn on a keyless model call.
    const model = registryModelWithCanonicalId(namespace, modelId, canonicalId);
    if (!model) return null;
    const apiKey = getEnvApiKey(namespace);
    if (apiKey === undefined) throw new NoCredentialsError(noKeyMessage(canonicalId), model);
    return { model, apiKey };
  }

  // A non-known namespace with no matching row is a deleted/unknown custom
  // provider — fail with a clear message rather than silently mis-resolving.
  throw new Error(`unknown or deleted provider: ${namespace}`);
}
