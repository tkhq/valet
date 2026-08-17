/**
 * The workspace a list surface should ask for.
 *
 * The nav's switcher holds a routing key (`"user"`, or a team id) and the
 * team id when scoped to a team. A list endpoint takes an OWNER — a type and
 * an id — so the personal workspace needs the caller's own user id, which
 * the switcher deliberately does not carry: its key is a routing value, not
 * a principal.
 *
 * This joins the two. It is the only thing a list route needs to become
 * workspace-aware.
 *
 * Returns `undefined` while the caller's identity is still loading. That is
 * NOT the same as the personal workspace: an unnarrowed list returns the
 * caller's own rows AND every team's they belong to. Returning `undefined`
 * briefly means the first render lists everything and then narrows, which is
 * the same behaviour every other query here has while it settles. A route
 * that must not show another workspace's rows even for one frame should gate
 * on the query's own pending state instead.
 */
import { useMe } from "~/api/settings";
import { useWorkspaceScope } from "./workspace-scope";
import type { OwnerFilter } from "~/api/client";

export function useListOwner(): OwnerFilter | undefined {
  const scope = useWorkspaceScope();
  const me = useMe();

  if (scope.teamId !== undefined) return { ownerType: "team", ownerId: scope.teamId };
  const userId = me.data?.id;
  if (userId === undefined) return undefined;
  return { ownerType: "user", ownerId: userId };
}

/**
 * The workspace for a list that also carries ORG-owned rows.
 *
 * A pin selects exactly one owner, so pinning your own user id hides
 * everything the org owns — for the skills catalog that is every skill an
 * org-wide repository imported, which is most of them. Org resources are not
 * personal property; they belong to every workspace.
 *
 * A team is still pinned, because a team's list is genuinely that team's. The
 * personal workspace sends no pin and gets the default union of your own rows,
 * your teams' and the org's.
 *
 * This asymmetry is a limit of the endpoint, not a preference: `scope` selects
 * a CLASS of owners and `pin` selects ONE, and the route refuses both at once.
 * Expressing "this workspace plus the org" needs a server change.
 */
export function useCatalogOwner(): OwnerFilter | undefined {
  const scope = useWorkspaceScope();
  if (scope.teamId !== undefined) return { ownerType: "team", ownerId: scope.teamId };
  return undefined;
}
