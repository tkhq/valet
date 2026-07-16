/**
 * LLM providers service — org-scoped provider row CRUD + the known-kind
 * per-org singleton rule (llm-providers design doc decision 1). `anthropic`,
 * `openai`, and `google` rows are singletons per org (enforced by the
 * partial unique index `llm_providers_org_kind_singleton` AND a pre-check
 * here, same belt-and-suspenders pattern as `services/teams.ts`'s
 * `createTeam` — the pre-check makes the common case return a clean error
 * without round-tripping through Postgres, the index catches the race).
 * `openai_compatible` rows are custom providers with no per-org limit.
 *
 * Model-id namespacing (design doc decision 2): `{providerKindOrRowId}/{modelId}`
 * — e.g. `anthropic/claude-haiku-4-5`, `prov_abc123/qwen-coder`. Bare ids
 * (no `/`) are back-compat and mean Anthropic. `isDefaultProviderNamespace`
 * below is the shared predicate for "is this row the org default model's
 * provider" that both the DELETE route (refuse while true) and future
 * resolution code (Task 5) can reuse.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { llmProviders, type LlmProviderModel, type LlmProviderRow } from "../schema/index.js";

export type LlmProviderKind = LlmProviderRow["kind"];

const KNOWN_KINDS: readonly LlmProviderKind[] = ["anthropic", "openai", "google"];

export function isLlmProviderKind(v: unknown): v is LlmProviderKind {
  return v === "anthropic" || v === "openai" || v === "google" || v === "openai_compatible";
}

export function isKnownProviderKind(kind: LlmProviderKind): boolean {
  return (KNOWN_KINDS as LlmProviderKind[]).includes(kind);
}

/** Thrown when creating a second `anthropic|openai|google` row for the same org. */
export class LlmProviderSingletonError extends Error {
  readonly code = "llm_provider_singleton";
  readonly statusCode = 409;
  constructor(orgId: string, kind: string) {
    super(`a ${kind} provider already exists for org ${orgId}`);
    this.name = "LlmProviderSingletonError";
  }
}

/** Exact copy string the delete-refused-while-default guard returns. */
export const DEFAULT_PROVIDER_IN_USE_ERROR = "provider is the org default model's provider";

function newProviderId(): string {
  return `prov_${randomUUID()}`;
}

/** True when a Postgres unique-constraint violation fired — within
 * `createLlmProvider`'s insert, the only unique index that can fire is
 * `llm_providers_org_kind_singleton` (row ids are freshly minted UUIDs). */
function isSingletonViolation(err: unknown): boolean {
  return isPgUniqueViolation(err);
}

export interface CreateLlmProviderOptions {
  orgId: string;
  kind: LlmProviderKind;
  name: string;
  baseUrl?: string;
  models?: LlmProviderModel[];
}

/**
 * Creates a provider row. The singleton pre-check runs before the insert
 * (plus a belt-and-suspenders catch on the unique index) so two concurrent
 * creates of the same known kind can't both pass the pre-check and race
 * into a raw 500 — the loser always sees `LlmProviderSingletonError`.
 */
export async function createLlmProvider(db: AppDb, opts: CreateLlmProviderOptions): Promise<LlmProviderRow> {
  const id = newProviderId();
  const row: LlmProviderRow = {
    id,
    orgId: opts.orgId,
    kind: opts.kind,
    name: opts.name,
    baseUrl: opts.baseUrl ?? null,
    enabled: true,
    models: opts.models ?? [],
    createdAt: Date.now(),
  };

  try {
    if (isKnownProviderKind(opts.kind)) {
      const existingRows = await db
        .select({ id: llmProviders.id })
        .from(llmProviders)
        .where(and(eq(llmProviders.orgId, opts.orgId), eq(llmProviders.kind, opts.kind)))
        .limit(1);
      if (existingRows[0]) throw new LlmProviderSingletonError(opts.orgId, opts.kind);
    }
    await db.insert(llmProviders).values(row);
  } catch (err) {
    if (err instanceof LlmProviderSingletonError) throw err;
    if (isSingletonViolation(err)) throw new LlmProviderSingletonError(opts.orgId, opts.kind);
    throw err;
  }

  return row;
}

/** Fetches a provider row scoped to `orgId` — a row in another org is treated as absent. */
export async function getLlmProvider(db: AppQueryable, orgId: string, id: string): Promise<LlmProviderRow | undefined> {
  const rows = await db
    .select()
    .from(llmProviders)
    .where(and(eq(llmProviders.orgId, orgId), eq(llmProviders.id, id)))
    .limit(1);
  return rows[0];
}

/** Lists every provider row for `orgId`, oldest first. */
export async function listLlmProviders(db: AppQueryable, orgId: string): Promise<LlmProviderRow[]> {
  return db.select().from(llmProviders).where(eq(llmProviders.orgId, orgId)).orderBy(llmProviders.createdAt);
}

export interface UpdateLlmProviderOptions {
  name?: string;
  baseUrl?: string | null;
  enabled?: boolean;
  models?: LlmProviderModel[];
}

/** Patches a provider row scoped to `orgId`; returns `undefined` when no such row exists (incl. cross-org). */
export async function updateLlmProvider(
  db: AppDb,
  orgId: string,
  id: string,
  patch: UpdateLlmProviderOptions,
): Promise<LlmProviderRow | undefined> {
  const existing = await getLlmProvider(db, orgId, id);
  if (!existing) return undefined;

  const update: Partial<LlmProviderRow> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.baseUrl !== undefined) update.baseUrl = patch.baseUrl;
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.models !== undefined) update.models = patch.models;

  if (Object.keys(update).length === 0) return existing;

  await db.update(llmProviders).set(update).where(and(eq(llmProviders.orgId, orgId), eq(llmProviders.id, id)));
  return { ...existing, ...update };
}

/** Deletes a provider row scoped to `orgId`. Idempotent — deleting an absent/cross-org id is a no-op. */
export async function deleteLlmProvider(db: AppDb, orgId: string, id: string): Promise<void> {
  await db.delete(llmProviders).where(and(eq(llmProviders.orgId, orgId), eq(llmProviders.id, id)));
}

/** A row's namespace in `orgs.modelPreferences` ids — the row id for custom
 * (`openai_compatible`) providers, the bare kind for known-kind providers. */
export function providerNamespace(row: LlmProviderRow): string {
  return row.kind === "openai_compatible" ? row.id : row.kind;
}

/**
 * True when `modelPreferences[0]` (the org default model) is namespaced to
 * `row`. Bare ids (no `/`) are back-compat and mean Anthropic (design doc
 * decision 2), so an unnamespaced default counts as `anthropic`'s namespace.
 */
export function isDefaultProviderNamespace(row: LlmProviderRow, modelPreferences: string[]): boolean {
  const first = modelPreferences[0];
  if (!first) return false;
  const slashIdx = first.indexOf("/");
  const namespace = slashIdx === -1 ? "anthropic" : first.slice(0, slashIdx);
  return namespace === providerNamespace(row);
}
