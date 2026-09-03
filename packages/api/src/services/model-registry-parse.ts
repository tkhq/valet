/**
 * Pure parsing and validation for the runtime model registry (TKAI-327).
 *
 * This module has no database and no network, so every rule below is unit
 * tested directly. It is the boundary that decides what a remote catalog is
 * allowed to put in front of a user: `services/model-registry.ts` fetches,
 * this file decides what survives.
 *
 * The upstream catalog mirrors the shape pi-ai bundles at
 * `providers/data/<provider>.json`: an object of API-group objects, each
 * holding model records keyed by id. pi-ai flattens the groups
 * (`flattenModelCatalog`); `parseRemoteCatalog` accepts either that grouped
 * shape or an already-flat map, because both are cheap to support and a
 * publisher may serve either.
 *
 * The rule for every helper here: a malformed entry is SKIPPED, never
 * guessed at and never thrown over. A registry that adds a field Valet does
 * not know keeps working; a registry that serves a truncated model record
 * loses that one model, not the whole catalog. `services/openrouter.ts`'s
 * `parseOpenrouterLiveModels` sets the same precedent.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** A validated pi-ai model record. Kept as the wide `Model<Api>` because a
 * remote catalog names its own `api`, and the catalog/resolution paths hold
 * models at that width already. */
export type RegistryModel = Model<Api>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * True when `value` carries every field the catalog and the resolver read
 * off a model. The check is deliberately structural rather than a full
 * schema: it pins the fields Valet depends on (`id`, `name`, `api`,
 * `provider`, `baseUrl`, `cost`, `contextWindow`, `maxTokens`) and lets
 * unknown extra fields through untouched, so an upstream addition needs no
 * Valet change.
 *
 * `cost` must be complete. Partial pricing is worse than none: it reaches
 * usage telemetry and bills a wrong number silently.
 */
export function isRegistryModel(value: unknown): value is RegistryModel {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["id"])) return false;
  if (!isNonEmptyString(value["name"])) return false;
  if (!isNonEmptyString(value["api"])) return false;
  if (!isNonEmptyString(value["provider"])) return false;
  if (typeof value["baseUrl"] !== "string") return false;
  if (typeof value["reasoning"] !== "boolean") return false;
  if (!Array.isArray(value["input"])) return false;
  if (!isFiniteNumber(value["contextWindow"])) return false;
  if (!isFiniteNumber(value["maxTokens"])) return false;

  const cost = value["cost"];
  if (!isRecord(cost)) return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!isFiniteNumber(cost[key])) return false;
  }
  return true;
}

/**
 * Parse an upstream catalog payload into validated models for one provider.
 *
 * Accepts the grouped shape pi-ai publishes (`{ "<api>": { "<id>": {...} } }`)
 * and a flat `{ "<id>": {...} }` map. Entries that fail validation are
 * skipped. Entries naming a different `provider` are skipped too: a catalog
 * served for `anthropic` must not inject models attributed elsewhere, which
 * would let one provider's fetch silently rewrite another's list.
 *
 * Returns an empty array for any payload it cannot read. The caller treats
 * empty as "no usable remote catalog" and keeps the bundled list.
 */
export function parseRemoteCatalog(providerId: string, payload: unknown): RegistryModel[] {
  if (!isRecord(payload)) return [];

  const out: RegistryModel[] = [];
  const seen = new Set<string>();

  const take = (candidate: unknown): void => {
    if (!isRegistryModel(candidate)) return;
    if (candidate.provider !== providerId) return;
    if (seen.has(candidate.id)) return;
    seen.add(candidate.id);
    out.push(candidate);
  };

  for (const group of Object.values(payload)) {
    if (!isRecord(group)) continue;
    // A flat map's values ARE model records; a grouped map's values are
    // objects of them. `isRegistryModel` tells the two apart without a
    // format flag, so one payload shape does not have to be declared.
    if (isRegistryModel(group)) {
      take(group);
      continue;
    }
    for (const entry of Object.values(group)) take(entry);
  }

  return out;
}

/** Parse an HTTP `Last-Modified` header into epoch ms, or `undefined` when
 * it is absent or unparseable. */
export function parseLastModified(header: string | null): number | undefined {
  if (!header) return undefined;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? ms : undefined;
}
