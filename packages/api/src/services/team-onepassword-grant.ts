/**
 * Team 1Password access is a lease of explicit `op://` refs, not a third
 * service-account token. The grant lives on a team-owned `onepassword` row
 * with no encrypted secret and `metadata.refs`. Resolve and the sandbox
 * broker consult this list; an ungranted ref does not fall through to the
 * org vault or a member's personal token.
 */
import type { CredentialStore, StoredCredential } from "@valet/engine";
import { ONEPASSWORD_SERVICE, OnePasswordAuthError } from "./onepassword.js";

/** Same shape the sandbox broker accepts: vault/item/field or one extra section. */
export const OP_REFERENCE = /^op:\/\/[^/\u0000-\u001f]+\/[^/\u0000-\u001f]+(?:\/[^/\u0000-\u001f]+){1,2}$/;

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
    if (!OP_REFERENCE.test(ref)) {
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
  return raw.filter((item): item is string => typeof item === "string" && OP_REFERENCE.test(item));
}

export async function loadTeamOnePasswordRefs(
  credentials: CredentialStore,
  teamId: string,
): Promise<string[]> {
  const row = await credentials.get({ type: "team", id: teamId }, ONEPASSWORD_SERVICE);
  return refsFromGrantRow(row);
}

export function isTeamOpRefGranted(refs: readonly string[], reference: string): boolean {
  return refs.includes(reference);
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
