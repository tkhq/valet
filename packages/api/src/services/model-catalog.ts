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
import { getEnvApiKey, getModels } from "@mariozechner/pi-ai";
import type { CredentialOwner, CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { getOrgModelPreferences } from "./org.js";
import { listLlmProviders } from "./llm-providers.js";
import type { ModelInfo } from "../wire/types.js";

export type CatalogEntry = ModelInfo & { resolvable: boolean };

/** The three known kinds pi-ai's registry covers — deliberately narrower
 * than `LlmProviderKind` (which also includes `openai_compatible`, handled
 * separately below since it has no pi-ai registry / env fallback). */
type KnownCatalogKind = "anthropic" | "openai" | "google";

const KNOWN_KINDS: readonly KnownCatalogKind[] = ["anthropic", "openai", "google"];

const KNOWN_KIND_LABEL: Record<KnownCatalogKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

const ANTHROPIC_PREFIX = "anthropic/";

async function hasOrgKey(credentials: CredentialStore, orgId: string, rowId: string): Promise<boolean> {
  const owner: CredentialOwner = { type: "org", id: orgId };
  const stored = await credentials.get(owner, `llm:${rowId}`);
  return stored !== null;
}

function knownKindEntries(
  kind: (typeof KNOWN_KINDS)[number],
  active: boolean,
  resolvable: boolean,
  providerId: string,
  providerName: string,
): CatalogEntry[] {
  return getModels(kind).map((m) => ({
    id: `${kind}/${m.id}`,
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
 * preference ids are back-compat and mean Anthropic. Returns the matching
 * index in `modelPreferences`, or -1 when unmatched. */
function preferenceIndex(entry: CatalogEntry, modelPreferences: string[]): number {
  const namespacedIdx = modelPreferences.indexOf(entry.id);
  if (namespacedIdx !== -1) return namespacedIdx;
  if (entry.providerKind === "anthropic" && entry.id.startsWith(ANTHROPIC_PREFIX)) {
    const bare = entry.id.slice(ANTHROPIC_PREFIX.length);
    const bareIdx = modelPreferences.indexOf(bare);
    if (bareIdx !== -1) return bareIdx;
  }
  return -1;
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
      entries.push(...knownKindEntries(kind, active, resolvable, row.id, row.name));
    } else {
      // No row for this kind — zero-config back-compat: synthesize a
      // registry entry only when the deployment env can resolve a key for
      // it (otherwise there's nothing selectable, and we'd rather stay
      // silent than list unusable models).
      const envKey = getEnvApiKey(kind);
      if (!envKey) continue;
      entries.push(...knownKindEntries(kind, true, true, kind, KNOWN_KIND_LABEL[kind]));
    }
  }

  for (const row of rows.filter((r) => r.kind === "openai_compatible")) {
    const resolvable = await hasOrgKey(credentials, orgId, row.id);
    const active = row.enabled && resolvable;
    for (const m of row.models) {
      entries.push({
        id: `${row.id}/${m.id}`,
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
    if (entry.providerKind === "anthropic" && entry.id.startsWith(ANTHROPIC_PREFIX)) {
      ids.add(entry.id.slice(ANTHROPIC_PREFIX.length));
    }
  }
  return ids;
}
