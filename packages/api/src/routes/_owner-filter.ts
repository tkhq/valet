/**
 * The shared `?ownerType=&ownerId=` reader (small-fixes design, task 1).
 *
 * A list route that scopes to the nav's workspace switcher takes the owner
 * as one pair of query parameters. The pair is all-or-nothing: half of it
 * names no principal, so the route answers 400 and the message says what to
 * send. Extracted from `routes/assistants.ts`, which now imports it.
 *
 * Three more readers of this shape stay where they are, because each
 * differs materially: `routes/memory.ts` throws instead of returning,
 * `routes/skills.ts` returns a status with the error, and
 * `routes/workflows.ts` returns a workflow owner ref rather than a
 * principal. `routes/sessions.ts` reads the pair inline and admits only
 * `user` and `team`. New owner-scoped routers import this one instead of
 * adding another copy, the same rule `_org-admin.ts` states.
 *
 * The reader validates shape only. A route that must also authorize the
 * named owner does that itself, because the bar differs: the memory routes
 * gate on `canViewSession`, while a route whose rows are already visible to
 * the whole org needs no gate at all.
 */
import type { Principal } from "@valet/engine";

const OWNER_TYPES: ReadonlySet<string> = new Set(["user", "team", "org"]);

function isOwnerType(value: string): value is Principal["type"] {
  return OWNER_TYPES.has(value);
}

/** The `?ownerType=&ownerId=` filter, or undefined when absent. Returns an
 * error string when one half is present and the other is not. */
export function readOwnerFilter(
  ownerType: string | undefined,
  ownerId: string | undefined,
): { owner?: Principal; error?: string } {
  if (ownerType === undefined && ownerId === undefined) return {};
  if (ownerType === undefined || ownerId === undefined) {
    return { error: "Filter by owner with both ownerType and ownerId, or send neither." };
  }
  if (!isOwnerType(ownerType)) {
    return { error: "ownerType must be 'user', 'team' or 'org'." };
  }
  return { owner: { type: ownerType, id: ownerId } };
}
