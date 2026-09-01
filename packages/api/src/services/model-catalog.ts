/**
 * Org model catalog — the org-aware replacement for the old static
 * Anthropic-only `/api/models` registry (llm-providers design doc, plan
 * Task 4). `buildOrgCatalog` unions:
 *
 *   - known provider kinds (`anthropic`/`openai`/`google`) — one row per org
 *     at most (Task 2/3's singleton rule). When a row exists, its models
 *     come from pi-ai's built-in registry (`getModels(kind)`) and it's
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
 * Ordering: entries the org has opted into (`orgs.modelPreferences`, most-
 * preferred first) sort first in that order, then the remaining active
 * entries sort alphabetically by (namespaced) id. Inactive entries
 * (disabled provider, or provider/row with no resolvable key) are appended
 * last — callers that only want the picker-visible set filter on `active`
 * (see `routes/models.ts`); `catalogValidIds` below already does this
 * filtering for validation call sites.
 *
 * Model-id namespacing mirrors `services/llm-providers.ts`:
 * `{providerKindOrRowId}/{modelId}`; bare ids (no `/`) are back-compat for
 * Anthropic. `catalogValidIds` returns both forms for active Anthropic
 * entries so `PATCH /api/me` and the preferences route can validate either
 * shape against one set.
 */
import { getEnvApiKey, getModels } from "@earendil-works/pi-ai/compat";
import type { CredentialOwner, CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { getOrgModelPreferences } from "./org.js";
import { isKnownProviderKind, listLlmProviders, parseModelId, providerNamespace } from "./llm-providers.js";
import { curatedOpenrouterModels, openrouterRegistry, toProviderModel } from "./openrouter.js";
import type { LlmProviderModel } from "../schema/index.js";
import type { ModelInfo } from "../wire/types.js";

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
 * `engine/host.ts`'s `orgPreferredModel` can reuse this exact check instead
 * of re-deriving "is this row usable" logic that could drift from the
 * catalog's own `active` definition. */
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
): CatalogEntry[] {
  return getModels(kind).map((m) => ({
    id: `${namespace}/${m.id}`,
    name: m.name,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
    providerId,
    providerKind: kind,
    providerName,
    active,
    pricing: { input: m.cost.input, output: m.cost.output },
    resolvable,
  }));
}

/** A preference entry matches a catalog entry either by its full namespaced
 * id, or (for Anthropic entries only) by the bare model id — bare
 * preference ids are back-compat and mean Anthropic (`parseModelId`,
 * shared with `services/llm-providers.ts`'s delete-guard/preferences
 * logic, is the single source of truth for that rule). Returns the
 * matching index in `modelPreferences`, or -1 when unmatched. */
function preferenceIndex(entry: CatalogEntry, modelPreferences: string[]): number {
  const namespacedIdx = modelPreferences.indexOf(entry.id);
  if (namespacedIdx !== -1) return namespacedIdx;
  const { namespace, modelId } = parseModelId(entry.id);
  if (namespace !== "anthropic") return -1;
  return modelPreferences.findIndex((p) => parseModelId(p).namespace === "anthropic" && parseModelId(p).modelId === modelId);
}

function orderEntries(entries: CatalogEntry[], modelPreferences: string[]): CatalogEntry[] {
  const active = entries.filter((e) => e.active);
  const inactive = entries.filter((e) => !e.active);

  const preferred = active
    .filter((e) => preferenceIndex(e, modelPreferences) !== -1)
    .sort((a, b) => preferenceIndex(a, modelPreferences) - preferenceIndex(b, modelPreferences));
  const rest = active
    .filter((e) => preferenceIndex(e, modelPreferences) === -1)
    .sort((a, b) => a.id.localeCompare(b.id));

  return [...preferred, ...rest, ...inactive];
}

/**
 * Builds the full org catalog — active AND inactive entries. Callers that
 * only want picker-visible models filter on `active` (see
 * `routes/models.ts`); `catalogValidIds` does this for validation.
 */
export async function buildOrgCatalog(db: AppQueryable, credentials: CredentialStore, orgId: string): Promise<CatalogEntry[]> {
  const rows = await listLlmProviders(db, orgId);
  const modelPreferences = await getOrgModelPreferences(db, orgId);

  const entries: CatalogEntry[] = [];

  for (const kind of KNOWN_KINDS) {
    const row = rows.find((r) => r.kind === kind);
    if (row) {
      const orgKey = await hasOrgKey(credentials, orgId, row.id);
      const resolvable = orgKey || Boolean(getEnvApiKey(kind));
      const active = row.enabled && resolvable;
      entries.push(...knownKindEntries(kind, providerNamespace(row), active, resolvable, row.id, row.name));
    } else {
      // No row for this kind — zero-config back-compat: synthesize a
      // registry entry only when the deployment env can resolve a key for
      // it (otherwise there's nothing selectable, and we'd rather stay
      // silent than list unusable models). No row exists to derive a
      // namespace from, so it's the kind itself (same value
      // `providerNamespace` would give a known-kind row).
      const envKey = getEnvApiKey(kind);
      if (!envKey) continue;
      entries.push(...knownKindEntries(kind, kind, true, true, kind, KNOWN_KIND_LABEL[kind]));
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
      entries.push({
        id: `${namespace}/${m.id}`,
        name: m.name,
        contextWindow: m.contextWindow,
        reasoning: reg?.reasoning,
        providerId,
        providerKind: "openrouter",
        providerName,
        active,
        pricing: m.pricing,
        resolvable,
      });
    }
  }

  for (const row of rows.filter((r) => !isKnownProviderKind(r.kind))) {
    const resolvable = await hasOrgKey(credentials, orgId, row.id);
    const active = row.enabled && resolvable;
    for (const m of row.models) {
      entries.push({
        id: `${providerNamespace(row)}/${m.id}`,
        name: m.name,
        contextWindow: m.contextWindow,
        providerId: row.id,
        providerKind: "openai_compatible",
        providerName: row.name,
        active,
        pricing: m.pricing,
        resolvable,
      });
    }
  }

  return orderEntries(entries, modelPreferences);
}

/**
 * Set of ids valid for `defaultModel`/preferences validation — ACTIVE
 * entries only. Anthropic entries contribute both their namespaced id
 * (`anthropic/x`) and the bare back-compat id (`x`).
 */
export function catalogValidIds(entries: CatalogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.active) continue;
    ids.add(entry.id);
    const { namespace, modelId } = parseModelId(entry.id);
    if (namespace === "anthropic") ids.add(modelId);
  }
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
    return "defaultModel must be a model id from GET /api/models, or null to clear the override.";
  }
  const entries = await buildOrgCatalog(db, credentials, orgId);
  if (!catalogValidIds(entries).has(value)) {
    return `unknown model: ${value}. Send a model id from GET /api/models.`;
  }
  return null;
}
