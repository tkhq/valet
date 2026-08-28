/**
 * Shared reader for the `?ownerType=&ownerId=` filter that owner-scoped list
 * routes take. Extracted from `routes/assistants.ts`. New owner-scoped
 * routers import this one instead of adding another copy.
 *
 * The reader validates shape only. A route that must also authorize the
 * named owner does that itself, because the bar differs per route.
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
