/**
 * Approved-models allowlist (model-selector-overhaul Task 3): the org's
 * approved model list, soft-gate validation, and tier-token bypass.
 *
 * An org can restrict which models members can select by maintaining an
 * allowlist in `orgs.approved_models` (jsonb, nullable). A null column means
 * "whole catalog approved". Org admins always bypass the list; members are
 * held to it. Tier tokens (xs, s, m, l, xl) always pass, since they resolve
 * at runtime via the tier map and may map to different models per org.
 */
import { eq } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { orgs } from "../schema/index.js";
import { TIER_SET } from "./model-tiers.js";

/**
 * Read the org's approved model list from `orgs.approved_models`.
 * Returns null when the column is null (whole catalog approved).
 */
export async function getApprovedModels(db: AppQueryable, orgId: string): Promise<string[] | null> {
  const rows = await db
    .select({ approvedModels: orgs.approvedModels })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  const raw = rows[0]?.approvedModels;
  if (!raw) return null;
  if (!Array.isArray(raw)) return null;
  if (raw.every((v) => typeof v === "string")) {
    return raw as string[];
  }
  return null;
}

/**
 * Persist the org's approved model list. Pass null to clear the restriction
 * (whole catalog approved).
 */
export async function setApprovedModels(
  db: AppQueryable,
  orgId: string,
  approved: string[] | null,
): Promise<void> {
  await db.update(orgs).set({ approvedModels: approved }).where(eq(orgs.id, orgId));
}

/**
 * Pure check: is a spec in the approved list?
 * - Null list always returns true (unrestricted).
 * - Tier tokens (xs, s, m, l, xl) always return true (resolved at runtime).
 * - Otherwise, check membership in the list.
 */
export function isApproved(approved: string[] | null, spec: string): boolean {
  // Null list: everything approved.
  if (approved === null) return true;

  // Tier tokens always pass (case-insensitive, like resolveModelSpec).
  if (TIER_SET.has(spec.trim().toLowerCase())) return true;

  // Check membership.
  return approved.includes(spec);
}

/**
 * Pure validation for `PUT /api/org/approved-models`: the empty-list rule
 * and catalog membership. `validIds` is the org's active-catalog id set
 * (`catalogValidIds(await buildOrgCatalog(...))`) so this stays DB-free and
 * unit-testable. Returns an error message naming the corrective action, or
 * null when the list is acceptable.
 */
export function validateApprovedModelsList(approved: string[] | null, validIds: ReadonlySet<string>): string | null {
  if (approved === null) return null;

  if (approved.length === 0) {
    return "Approved list cannot be empty. To approve the whole catalog, clear the restriction instead.";
  }

  for (const id of approved) {
    if (!validIds.has(id)) {
      return `Unknown model "${id}". Pick a model from the model list (GET /api/models).`;
    }
  }

  return null;
}

/**
 * Validate that a model spec can be selected for the given org.
 * Returns null if OK, or an error message string if the spec is not allowed.
 *
 * - Org admin → always null (no gate).
 * - Tier token → always null (resolved at runtime).
 * - Null list (unrestricted) → always null.
 * - Otherwise, check membership in the approved list; if not present, return
 *   an error message naming the corrective action.
 */
export async function assertModelSelectable(
  db: AppQueryable,
  orgId: string,
  isOrgAdmin: boolean,
  spec: string,
): Promise<string | null> {
  // Admins always pass.
  if (isOrgAdmin) return null;

  // Get the approved list.
  const approved = await getApprovedModels(db, orgId);

  // Check if the spec is approved.
  if (!isApproved(approved, spec)) {
    return `Model "${spec}" is not in the org's approved list. Ask an org admin to approve it in Settings → Organization → Models.`;
  }

  return null;
}
