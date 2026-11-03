import type { TeamSummary } from "@valet/api/wire";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";

/**
 * Spaces: your own, and one per team you belong to. The sidebar lists them
 * (`SpacesNav`), with each space's pages one click away.
 *
 * A team with no assistant is still listed. It owns skills and workflows,
 * and hiding it would read as removal from the team.
 */
export interface WorkspaceOption {
  /** `user` for your own, else the team id. Stable across renders. */
  key: string;
  label: string;
  isTeam: boolean;
}

/** The spaces a caller has, in sidebar order: yours first, then teams as
 * `GET /api/teams` returned them. */
export function workspaceOptions(teams: TeamSummary[]): WorkspaceOption[] {
  return [
    { key: "user", label: "Personal", isTeam: false },
    ...teams.map(t => ({ key: t.id, label: t.name, isTeam: true })),
  ];
}

/** The caller's spaces: Personal, then each team they can open. */
export function useWorkspaceOptions(): WorkspaceOption[] {
  const teamsQ = useTeams();
  const orgQ = useOrg();
  return workspaceOptions(eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations));
}
