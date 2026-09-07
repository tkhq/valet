/**
 * A team 1Password grant is an optional restriction, not a default denial.
 * A team session reads the org scope (product decision 2026-09-06). A team
 * admin may narrow that to an explicit list of `op://` refs. The list lives
 * on the team-owned `onepassword` row as `metadata.refs`, with no encrypted
 * secret today. Resolve and the sandbox broker consult the list only when
 * one exists: with no grant row, every ref the org token can see resolves;
 * with one, an ungranted ref is refused and names the fix.
 */
import type { CredentialStore, StoredCredential } from "@valet/engine";
import { isOnePasswordReference, ONEPASSWORD_SERVICE, OnePasswordAuthError } from "./onepassword.js";

export const MAX_TEAM_OP_REFS = 25;

export const UNGRANTED_TEAM_OP_REF =
  "This 1Password reference is not granted to the team. Ask a team admin to grant it.";

export function parseTeamOnePasswordRefs(value: unknown): { ok: true; refs: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return { ok: false, error: "Send refs as an array of op://vault/item/field strings." };
  }
  if (value.length > MAX_TEAM_OP_REFS) {
    return { ok: false, error: `Grant at most ${MAX_TEAM_OP_REFS} references.` };
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const ref = raw.trim();
    if (!isOnePasswordReference(ref)) {
      return { ok: false, error: `${raw} is not a supported secret reference. Use op://vault/item/field.` };
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return { ok: true, refs };
}

export function refsFromGrantRow(row: StoredCredential | null): string[] {
  if (!row?.metadata || typeof row.metadata !== "object" || Array.isArray(row.metadata)) return [];
  const raw = row.metadata.refs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && isOnePasswordReference(item));
}

/**
 * The team's lease, or `null` when the team has none. An absent row and a
 * row with no valid refs both read as no lease: the PUT route deletes the
 * row for an empty list, so an empty list never means "grant nothing".
 */
export async function loadTeamOnePasswordRefs(
  credentials: CredentialStore,
  teamId: string,
): Promise<readonly string[] | null> {
  const row = await credentials.get({ type: "team", id: teamId }, ONEPASSWORD_SERVICE);
  const refs = refsFromGrantRow(row);
  return refs.length > 0 ? refs : null;
}

/** `null` is no lease, so every reference the org scope can read is granted. */
export function isTeamOpRefGranted(refs: readonly string[] | null, reference: string): boolean {
  return refs === null || refs.includes(reference);
}

export function refuseUngrantedTeamOpRef(): never {
  throw new OnePasswordAuthError(UNGRANTED_TEAM_OP_REF, "scope");
}

export function grantRow(refs: string[]): StoredCredential {
  return {
    type: "service_account",
    metadata: { refs },
  };
}
