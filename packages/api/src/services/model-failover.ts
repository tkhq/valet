/**
 * Provider failover candidates (TKAI-326) — the api-side policy behind the
 * engine's `resolveFailoverModels` seam. Given the model spec a turn kept
 * failing on, return ordered equivalent-model specs on OTHER providers so
 * the transient turn retry can run that one turn elsewhere (an Anthropic
 * capacity event must not lose an orchestrator turn when the org also has
 * an OpenAI key).
 *
 * Equivalence = same capability tier. Tiers are S/M/L, classified from the
 * model id's family name (haiku/mini/lite → S, opus/pro → L), then the
 * output price when the catalog knows it, then M. This is a static policy
 * map in code (TKAI-326 decision 4), not configuration — revisit when the
 * per-org tier preferences ship.
 *
 * Candidate order (TKAI-326 decision 2 — derived from existing config, no
 * new schema):
 *   1. Org model preferences (`orgs.model_preferences`, most-preferred
 *      first): entries on another vendor, same tier, active in the
 *      catalog.
 *   2. Static per-kind defaults (`TIER_DEFAULTS`), known kinds in fixed
 *      order, filtered to models active in the org catalog.
 *
 * Exclusion is by upstream VENDOR, not provider row: a custom
 * openai_compatible proxy fronting OpenAI, or an OpenRouter selection of
 * an Anthropic model, must not "fail over" to the same vendor that is
 * melting down. One candidate per vendor (the first wins). "Active"
 * already encodes the credential check (enabled row + usable key), and
 * the engine re-resolves each candidate through `resolveModel` at switch
 * time, so a key revoked between lookup and switch is skipped, not fatal.
 *
 * Failover never fires on quota/billing/auth errors — the engine's
 * transient classifier (`isRetryableAssistantError`) gates the whole retry
 * loop, and this module is only consulted from inside it.
 */
import type { CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import {
  buildOrgCatalog,
  KNOWN_KINDS,
  preferenceIndex,
  type CatalogEntry,
  type KnownCatalogKind,
} from "./model-catalog.js";
import { getOrgModelPreferences } from "./org.js";
import { parseModelId } from "./llm-providers.js";

export type ModelTier = "S" | "M" | "L";

/**
 * Static same-tier defaults per known kind, best first. Ids must exist in
 * pi-ai's registry; the self-consistency test in model-failover.test.ts
 * asserts every id here is catalog-resolvable and classifies as its
 * declared tier, so registry churn fails a test instead of silently
 * shrinking coverage. The L tier deliberately avoids the ultra-priced
 * "pro" reasoning models (gpt-5.5-pro is ~7x Opus's output price) — a
 * failover turn must not become a cost spike (TKAI-326 risk 2).
 */
export const TIER_DEFAULTS: Record<KnownCatalogKind, Record<ModelTier, string[]>> = {
  anthropic: {
    S: ["claude-haiku-4-5"],
    M: ["claude-sonnet-4-6", "claude-sonnet-4-5"],
    L: ["claude-opus-4-8", "claude-opus-4-7"],
  },
  openai: {
    S: ["gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini"],
    M: ["gpt-5.4", "gpt-5.2", "gpt-4.1"],
    L: ["gpt-5.5", "gpt-5.6-sol", "o1"],
  },
  google: {
    S: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite"],
    M: ["gemini-flash-latest", "gemini-2.5-flash"],
    L: ["gemini-3.1-pro-preview", "gemini-2.5-pro"],
  },
};

/** Most candidates ever returned — the retry loop rarely consumes more
 * than one (default maxAttempts is 2: one same-model retry, one failover). */
const MAX_CANDIDATES = 3;

/**
 * Classify a model id into a capability tier. Distinct family markers
 * first (they are stable across registry churn), then the output-price
 * band — "gpt" and "gemini" span three orders of magnitude of price, so a
 * broad vendor-word match must not pre-empt a known price — then M, the
 * safest wrong answer, since every provider has a mid model.
 */
export function classifyModelTier(modelId: string, outputPricePerMtok?: number): ModelTier {
  const id = modelId.toLowerCase();
  // Suffix markers ("mini", "pro") must match as whole id segments —
  // "gemini" contains "mini" and must NOT read as small.
  const segment = (word: string) => new RegExp(`(^|[-._/])${word}($|[-._/])`).test(id);
  if (/haiku/.test(id) || segment("mini") || segment("nano") || segment("lite")) return "S";
  if (/opus|fable|mythos/.test(id) || segment("pro") || segment("o1")) return "L";
  if (outputPricePerMtok !== undefined) {
    if (outputPricePerMtok < 2) return "S";
    if (outputPricePerMtok <= 25) return "M";
    return "L";
  }
  return "M";
}

/**
 * The upstream vendor behind a catalog entry — the melt-down domain the
 * exclusion works in. Known kinds are their own vendor; OpenRouter model
 * ids carry the vendor as their first segment; custom rows are inferred
 * from the model family (a proxy serving "gpt-5.4" fronts OpenAI). An
 * unrecognizable id falls back to the provider namespace: the row is then
 * its own vendor, which keeps two distinct unknown proxies distinct.
 */
function inferVendor(providerKind: string, namespace: string, modelId: string): string {
  if (providerKind === "anthropic" || providerKind === "openai" || providerKind === "google") {
    return providerKind;
  }
  if (providerKind === "openrouter") {
    const slash = modelId.indexOf("/");
    if (slash > 0) return modelId.slice(0, slash);
  }
  const id = modelId.toLowerCase();
  if (/claude/.test(id)) return "anthropic";
  if (/gpt|codex/.test(id) || /^o\d/.test(id)) return "openai";
  if (/gemini|gemma/.test(id)) return "google";
  return namespace;
}

/**
 * Ordered failover candidates for `spec`, as catalog-namespaced specs the
 * engine can feed straight to `resolveModel`. Empty when the org has no
 * usable same-tier model on another vendor. `db` absent (host builders
 * without an app db) === no candidates.
 */
export async function failoverCandidates(
  db: AppQueryable | undefined,
  credentials: CredentialStore,
  orgId: string,
  spec: string,
): Promise<string[]> {
  if (!db) return [];
  const { namespace: failingNs, modelId: failingModelId } = parseModelId(spec);
  // buildOrgCatalog fetches the preferences again internally for its own
  // ordering; the second read is the price of keeping its signature
  // stable, so at least run the two in parallel.
  const [catalog, prefs] = await Promise.all([
    buildOrgCatalog(db, credentials, orgId),
    getOrgModelPreferences(db, orgId),
  ]);
  const active = catalog.filter((e) => e.active);
  const byId = new Map(active.map((e) => [e.id, e]));

  const failingEntry = byId.get(`${failingNs}/${failingModelId}`);
  const tier = classifyModelTier(failingModelId, failingEntry?.pricing?.output);
  const failingVendor = inferVendor(
    failingEntry?.providerKind ?? failingNs,
    failingNs,
    failingModelId,
  );

  const candidates: string[] = [];
  const usedVendors = new Set<string>([failingVendor]);
  const push = (entry: CatalogEntry) => {
    const { namespace, modelId } = parseModelId(entry.id);
    // The failing provider ROW is always excluded, even when its vendor
    // could not be inferred; every other entry dedupes by vendor.
    if (namespace === failingNs) return;
    const vendor = inferVendor(entry.providerKind, namespace, modelId);
    if (usedVendors.has(vendor)) return;
    usedVendors.add(vendor);
    candidates.push(entry.id);
  };

  // Pass 1 — the org's own preference order. `preferenceIndex` is the
  // codebase's single encoding of the bare-id-means-anthropic match.
  const preferred = active
    .map((entry) => ({ entry, idx: preferenceIndex(entry, prefs) }))
    .filter((p) => p.idx !== -1)
    .sort((a, b) => a.idx - b.idx);
  for (const { entry } of preferred) {
    const { modelId } = parseModelId(entry.id);
    if (classifyModelTier(modelId, entry.pricing?.output) !== tier) continue;
    push(entry);
  }

  // Pass 2 — static defaults for any known kind the preferences left out.
  for (const kind of KNOWN_KINDS) {
    if (usedVendors.has(kind)) continue;
    const entry = TIER_DEFAULTS[kind][tier]
      .map((id) => byId.get(`${kind}/${id}`))
      .find((e) => e !== undefined);
    if (entry) push(entry);
  }

  return candidates.slice(0, MAX_CANDIDATES);
}
