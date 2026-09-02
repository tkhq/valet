/**
 * Provider failover candidates (TKAI-326) — the api-side policy behind the
 * engine's `resolveFailoverModels` seam. Given the model spec a turn kept
 * failing on, return ordered equivalent-model specs on OTHER providers so
 * the transient turn retry can run that one turn elsewhere (an Anthropic
 * capacity event must not lose an orchestrator turn when the org also has
 * an OpenAI key).
 *
 * Equivalence = same capability tier. Tiers are S/M/L, classified from the
 * model id's family name (haiku/mini/lite → S, opus/pro → L, ...) with an
 * output-price fallback for ids no pattern knows. This is a static policy
 * map in code (TKAI-326 decision 4), not configuration — revisit when the
 * per-org tier preferences ship.
 *
 * Candidate order (TKAI-326 decision 2 — derived from existing config, no
 * new schema):
 *   1. Org model preferences (`orgs.model_preferences`, most-preferred
 *      first): entries on another provider, same tier, active in the
 *      catalog.
 *   2. Static per-kind defaults (`TIER_DEFAULTS`), known kinds in fixed
 *      order, filtered to models active in the org catalog.
 * One candidate per provider (the first wins); the failing provider never
 * contributes. "Active" already encodes the credential check (enabled row
 * + usable key), and the engine re-resolves each candidate through
 * `resolveModel` at switch time, so a key revoked between lookup and
 * switch is skipped, not fatal.
 *
 * Failover never fires on quota/billing/auth errors — the engine's
 * transient classifier (`isRetryableAssistantError`) gates the whole retry
 * loop, and this module is only consulted from inside it.
 */
import type { CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { buildOrgCatalog, type CatalogEntry } from "./model-catalog.js";
import { getOrgModelPreferences } from "./org.js";
import { parseModelId } from "./llm-providers.js";

export type ModelTier = "S" | "M" | "L";

/** Known kinds that carry static failover defaults, in precedence order. */
const DEFAULT_KIND_ORDER = ["anthropic", "openai", "google"] as const;

/**
 * Static same-tier defaults per known kind, best first. Ids must exist in
 * pi-ai's registry; a stale id is skipped by the catalog check, so pruning
 * here lags registry churn safely. The L tier deliberately avoids the
 * ultra-priced "pro" reasoning models (gpt-5.5-pro is ~7x Opus's output
 * price) — a failover turn must not become a cost spike (TKAI-326 risk 2).
 */
const TIER_DEFAULTS: Record<(typeof DEFAULT_KIND_ORDER)[number], Record<ModelTier, string[]>> = {
  anthropic: {
    S: ["claude-haiku-4-5"],
    M: ["claude-sonnet-4-6", "claude-sonnet-4-5"],
    L: ["claude-opus-4-8", "claude-opus-4-7"],
  },
  openai: {
    S: ["gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini"],
    M: ["gpt-5.4", "gpt-5.2", "gpt-4.1"],
    L: ["gpt-5.5", "gpt-5.4", "o3"],
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
 * Classify a model id into a capability tier. Family-name patterns first
 * (they are stable across registry churn), then an output-price band for
 * ids no pattern knows (custom/openrouter models), then M — the safest
 * wrong answer, since every provider has a mid model.
 */
export function classifyModelTier(modelId: string, outputPricePerMtok?: number): ModelTier {
  const id = modelId.toLowerCase();
  // Suffix markers ("mini", "pro") must match as whole id segments —
  // "gemini" contains "mini" and must NOT read as small.
  const segment = (word: string) => new RegExp(`(^|[-._/])${word}($|[-._/])`).test(id);
  if (/haiku/.test(id) || segment("mini") || segment("nano") || segment("lite")) return "S";
  if (/opus|fable|mythos/.test(id) || segment("pro") || segment("o1")) return "L";
  if (/sonnet|flash|gpt|gemini/.test(id) || /^o\d/.test(id)) return "M";
  if (outputPricePerMtok !== undefined) {
    if (outputPricePerMtok < 2) return "S";
    if (outputPricePerMtok <= 25) return "M";
    return "L";
  }
  return "M";
}

/** Namespace of a catalog entry's id (`anthropic/x` → `anthropic`). */
function entryNamespace(entry: CatalogEntry): string {
  return parseModelId(entry.id).namespace;
}

/**
 * Ordered failover candidates for `spec`, as catalog-namespaced specs the
 * engine can feed straight to `resolveModel`. Empty when the org has no
 * usable same-tier model on another provider. `db` absent (host builders
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
  const catalog = await buildOrgCatalog(db, credentials, orgId);
  const active = catalog.filter((e) => e.active);
  const byId = new Map(active.map((e) => [e.id, e]));

  const failingEntry = byId.get(`${failingNs}/${failingModelId}`);
  const tier = classifyModelTier(failingModelId, failingEntry?.pricing?.output);

  const candidates: string[] = [];
  const usedNamespaces = new Set<string>([failingNs]);
  const push = (entry: CatalogEntry) => {
    const ns = entryNamespace(entry);
    if (usedNamespaces.has(ns)) return;
    usedNamespaces.add(ns);
    candidates.push(entry.id);
  };

  // Pass 1 — the org's own preference order. Bare preference entries are
  // Anthropic back-compat (`parseModelId`'s rule).
  for (const pref of await getOrgModelPreferences(db, orgId)) {
    const { namespace, modelId } = parseModelId(pref);
    const entry = byId.get(`${namespace}/${modelId}`);
    if (!entry) continue;
    if (classifyModelTier(modelId, entry.pricing?.output) !== tier) continue;
    push(entry);
  }

  // Pass 2 — static defaults for any known kind the preferences left out.
  for (const kind of DEFAULT_KIND_ORDER) {
    for (const id of TIER_DEFAULTS[kind][tier]) {
      const entry = byId.get(`${kind}/${id}`);
      if (entry) {
        push(entry);
        break;
      }
    }
  }

  return candidates.slice(0, MAX_CANDIDATES);
}
