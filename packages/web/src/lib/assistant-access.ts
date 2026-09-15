import type { AssistantOwner, TeamSummary } from "@valet/api/wire";

/**
 * Who may change an assistant: your own for a user assistant, team admin (or
 * org admin) for a team's. The API enforces it. The client uses it to hide
 * controls that would 403, to gate the editor into read-only, and to say
 * whether a link leads to an editor or to a read-only view.
 *
 * It lives here, not beside the rail that first needed it, so a component
 * can ask the question without importing the rail.
 */
export function canAdministerOwner(
  owner: AssistantOwner,
  me: { id: string; orgRole: "admin" | "member" } | undefined,
  teams: TeamSummary[] | undefined,
): boolean {
  if (owner.type === "user") return me?.id === owner.id;
  if (me?.orgRole === "admin") return true;
  const team = teams?.find((t) => t.id === owner.id);
  return team?.callerRole === "admin";
}
