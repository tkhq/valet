/**
 * Org model catalog — the org-aware replacement for the old static
 * Anthropic-only `/api/models` registry (llm-providers design doc, plan
 * Task 4). `buildOrgCatalog` unions:
 *
 *   - known provider kinds (`anthropic`/`openai`/`google`) — one row per org
 *     at most (Task 2/3's singleton rule). When a row exists, its models
 *     come from the runtime model registry (`registryModels(kind)`, see
 *     `services/model-registry.ts` — upstream when a refresh has landed,
 *     the bundled compile-time catalog otherwise) and it's
 *     "resolvable" when an org credential exists at `llm:{row.id}` OR (for
 *     known kinds only) `getEnvApiKey(kind)` resolves. When NO row exists
 *     for a known kind, the catalog synthesizes a registry entry anyway
 *     whenever the env fallback resolves — this is the "zero-config" pin:
 *     an org with zero `llm_providers` rows and only `ANTHROPIC_API_KEY` in
 *     the deployment env must see exactly today's static Anthropic list.
 *   - custom `openai_compatible` rows — any number per org, models come
 *     from the row's own declared `models` array, resolvable ONLY via an
 *     org credential (no env fallback for custom providers).
 *
 * Ordering: entries keep their natural construction order (known kinds in
 * `KNOWN_KINDS` order, then OpenRouter, then custom `openai_compatible`
 * rows). Inactive entries (disabled provider, or provider/row with no
 * resolvable key) are appended last — callers that only want the
 * picker-visible set filter on `active` (see `routes/models.ts`);
 * `catalogValidIds` below already does this filtering for validation call
 * sites. The per-tier ordered target lists (`services/model-tiers.ts`) are
 * the org-level fallback chain now; the catalog itself carries no
 * preference order.
 *
 * Model-id namespacing mirrors `services/llm-providers.ts`:
 * `{providerKindOrRowId}/{modelId}`; bare ids (no `/`) are back-compat for
 * Anthropic. `catalogValidIds` returns both forms for active Anthropic
 * entries so `PATCH /api/me` and other model-accepting routes can validate
 * either shape against one set.
 */
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { registryModels } from "./model-registry.js";
import type { CredentialOwner, CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { isKnownProviderKind, listLlmProviders, parseModelId, providerNamespace } from "./llm-providers.js";
import { curatedOpenrouterModels, openrouterRegistry, toProviderModel } from "./openrouter.js";
import type { LlmProviderModel } from "../schema/index.js";
import type { ModelInfo } from "../wire/types.js";
import { TIER_TOKENS } from "./model-tiers.js";
import { getApprovedModels, isApproved } from "./approved-models.js";

/** Canonical display/selection order for thinking levels — narrowest to
 * broadest effort. `"off"` is never a selectable level, so it's excluded
 * here rather than filtered out at every call site. */
const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The levels a reasoning model actually supports, in canonical order.
 * `undefined` when the model doesn't reason at all, or the registry has no
 * `thinkingLevelMap` for it (nothing to report). Only keys PRESENT in the
 * map are considered — a `null` value marks a level explicitly unsupported,
 * and a missing key is not claimed as supported either. */
function thinkingLevelsFor(reasoning: boolean | undefined, map: ThinkingLevelMap | undefined): string[] | undefined {
  if (!reasoning || !map) return undefined;
  return THINKING_LEVEL_ORDER.filter((level) => map[level] !== undefined && map[level] !== null);
}

export type CatalogEntry = ModelInfo & { resolvable: boolean };

/** The registry-backed known kinds whose FULL registry surfaces in the
 * catalog — deliberately narrower than `LlmProviderKind`: `openrouter` is
 * registry-backed too but its ~274 models would flood pickers, so it goes
 * through a curated-selection branch below; `openai_compatible` has no
 * pi-ai registry / env fallback at all. */
type KnownCatalogKind = "anthropic" | "openai" | "google";

const KNOWN_KINDS: readonly KnownCatalogKind[] = ["anthropic", "openai", "google"];

const KNOWN_KIND_LABEL: Record<KnownCatalogKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/** True when an org credential exists at `llm:{rowId}` — the sole
 * resolvability signal for a custom (`openai_compatible`) row (no env
 * fallback, mirrors `resolveModelSpec`'s throw condition). Exported so
 * `engine/host.ts`'s `firstActivePreference` can reuse this exact check
 * instead of re-deriving "is this row usable" logic that could drift from
 * the catalog's own `active` definition. */
export async function hasOrgKey(credentials: CredentialStore, orgId: string, rowId: string): Promise<boolean> {
  const owner: CredentialOwner = { type: "org", id: orgId };
  const stored = await credentials.get(owner, `llm:${rowId}`);
  return stored !== null;
}

function knownKindEntries(
  kind: (typeof KNOWN_KINDS)[number],
  namespace: string,
  active: boolean,
  resolvable: boolean,
  providerId: string,
  providerName: string,
  approvedList: string[] | null,
): CatalogEntry[] {
  return registryModels(kind).map((m) => {
    const id = `${namespace}/${m.id}`;
    return {
      id,
      name: m.name,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      providerId,
      providerKind: kind,
      providerName,
      active,
      pricing: { input: m.cost.input, output: m.cost.output },
      resolvable,
      approved: isApproved(approvedList, id),
      thinkingLevels: thinkingLevelsFor(m.reasoning, m.thinkingLevelMap),
    };
  });
}

/** Active entries keep their natural construction order; inactive entries
 * (disabled provider, or no resolvable key) sort after them, also in
 * construction order. No preference reordering — the org's per-tier target
 * lists are the fallback chain now, not the catalog's own order. */
function orderEntries(entries: CatalogEntry[]): CatalogEntry[] {
  const active = entries.filter((e) => e.active);
  const inactive = entries.filter((e) => !e.active);
  return [...active, ...inactive];
}

/**
 * Builds the full org catalog — active AND inactive entries. Callers that
 * only want picker-visible models filter on `active` (see
 * `routes/models.ts`); `catalogValidIds` does this for validation.
 */
export async function buildOrgCatalog(db: AppQueryable, credentials: CredentialStore, orgId: string): Promise<CatalogEntry[]> {
  const rows = await listLlmProviders(db, orgId);
  // Fetched once per build (not per entry) — every entry's `approved` flag
  // is derived from this same snapshot.
  const approvedList = await getApprovedModels(db, orgId);

  const entries: CatalogEntry[] = [];

  for (const kind of KNOWN_KINDS) {
    const row = rows.find((r) => r.kind === kind);
    if (row) {
      const orgKey = await hasOrgKey(credentials, orgId, row.id);
      const resolvable = orgKey || Boolean(getEnvApiKey(kind));
      const active = row.enabled && resolvable;
      entries.push(...knownKindEntries(kind, providerNamespace(row), active, resolvable, row.id, row.name, approvedList));
    } else {
      // No row for this kind — zero-config back-compat: synthesize a
      // registry entry only when the deployment env can resolve a key for
      // it (otherwise there's nothing selectable, and we'd rather stay
      // silent than list unusable models). No row exists to derive a
      // namespace from, so it's the kind itself (same value
      // `providerNamespace` would give a known-kind row).
      const envKey = getEnvApiKey(kind);
      if (!envKey) continue;
      entries.push(...knownKindEntries(kind, kind, true, true, kind, KNOWN_KIND_LABEL[kind], approvedList));
    }
  }

  // OpenRouter — registry-backed like the known kinds above, but exposure
  // is the row's curated selection (or the curated defaults on zero-config
  // env-key boots), never the full registry. Selection entries re-resolve
  // against the registry when present (pricing/context stay current);
  // entries the registry doesn't know (added from OpenRouter's LIVE
  // catalog via the picker) surface with their stored row metadata — same
  // trust model as custom providers' declared lists.
  {
    const row = rows.find((r) => r.kind === "openrouter");
    const registry = openrouterRegistry();
    let selection: LlmProviderModel[] | undefined;
    let active = false;
    let resolvable = false;
    let namespace = "openrouter";
    let providerId = "openrouter";
    let providerName = "OpenRouter";
    if (row) {
      const orgKey = await hasOrgKey(credentials, orgId, row.id);
      resolvable = orgKey || Boolean(getEnvApiKey("openrouter"));
      active = row.enabled && resolvable;
      namespace = providerNamespace(row);
      providerId = row.id;
      providerName = row.name;
      selection = row.models;
    } else if (getEnvApiKey("openrouter")) {
      resolvable = true;
      active = true;
      selection = curatedOpenrouterModels();
    }
    for (const sel of selection ?? []) {
      const reg = registry.get(sel.id);
      const m = reg ? toProviderModel(reg) : sel;
      const id = `${namespace}/${m.id}`;
      entries.push({
        id,
        name: m.name,
        contextWindow: m.contextWindow,
        reasoning: reg?.reasoning,
        providerId,
        providerKind: "openrouter",
        providerName,
        active,
        pricing: m.pricing,
        resolvable,
        approved: isApproved(approvedList, id),
        thinkingLevels: thinkingLevelsFor(reg?.reasoning, reg?.thinkingLevelMap),
      });
    }
  }

  for (const row of rows.filter((r) => !isKnownProviderKind(r.kind))) {
    const resolvable = await hasOrgKey(credentials, orgId, row.id);
    const active = row.enabled && resolvable;
    for (const m of row.models) {
      const id = `${providerNamespace(row)}/${m.id}`;
      entries.push({
        id,
        name: m.name,
        contextWindow: m.contextWindow,
        providerId: row.id,
        providerKind: "openai_compatible",
        providerName: row.name,
        active,
        pricing: m.pricing,
        resolvable,
        approved: isApproved(approvedList, id),
        // No pi-ai registry entry exists for a custom row's declared model
        // (there's nothing upstream to look reasoning up against), so it
        // never has a thinkingLevels list.
      });
    }
  }

  return orderEntries(entries);
}

/**
 * Set of ids valid for model-field validation (`defaultModel`, tier
 * targets, assistant model, approved-models entries) — ACTIVE entries only.
 * Anthropic entries contribute both their namespaced id (`anthropic/x`) and
 * the bare back-compat id (`x`).
 */
export function catalogValidIds(entries: CatalogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.active) continue;
    ids.add(entry.id);
    const { namespace, modelId } = parseModelId(entry.id);
    if (namespace === "anthropic") ids.add(modelId);
  }
  // Tier tokens are valid model specs (TKAI-285).
  for (const tier of TIER_TOKENS) ids.add(tier);
  return ids;
}

/**
 * Validates a default-model id against the org catalog. One definition for
 * every route that writes a default-model field (`PATCH /api/me`,
 * `PATCH /api/teams/:id`), so the accepted id set and the error wording
 * cannot drift between them. Returns the error message to 400 with, or
 * `null` when `value` is acceptable (`null` clears the override and is
 * always acceptable).
 */
export async function validateDefaultModelId(
  db: AppQueryable,
  credentials: CredentialStore,
  orgId: string,
  value: unknown,
): Promise<string | null> {
  if (value === null) return null;
  if (typeof value !== "string") {
    return "defaultModel must be a model id from the model list (GET /api/models), or null to clear the override.";
  }
  const entries = await buildOrgCatalog(db, credentials, orgId);
  if (!catalogValidIds(entries).has(value)) {
    return `unknown model: ${value}. Pick a model from the model list (GET /api/models).`;
  }
  return null;
}
