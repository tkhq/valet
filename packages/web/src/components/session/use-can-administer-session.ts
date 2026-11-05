import type { AssistantOwner, ListTeamsResponse, MeResponse } from "@valet/api/wire";
import { useMe, useTeams } from "~/api/settings";

/**
 * Pure: true when the viewer may run a session's lifecycle controls (model,
 * pause, delete, stopping background work). A session that no team owns
 * always passes. A team session needs a team admin or an org admin. The API
 * enforces the same rule; this only hides controls that would 404.
 */
export function canAdministerSession(
  owner: AssistantOwner,
  teams: ListTeamsResponse | undefined,
  me: MeResponse | undefined,
): boolean {
  if (owner.type !== "team") return true;
  const team = teams?.teams.find((t) => t.id === owner.id);
  return team?.callerRole === "admin" || me?.orgRole === "admin";
}

/** `canAdministerSession` for the signed-in viewer. */
export function useCanAdministerSession(owner: AssistantOwner | undefined): boolean {
  const me = useMe();
  const teams = useTeams({ enabled: owner?.type === "team" });
  return owner ? canAdministerSession(owner, teams.data, me.data) : false;
}
