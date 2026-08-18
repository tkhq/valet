/**
 * The workspace clause — one grammar for "where am I".
 *
 * The switcher beside the logo scopes every list under it, but a control
 * only orients you while you are looking at it. These components repeat its
 * answer where the reader's eyes actually are: a quiet clause beside a page
 * title (`WorkspaceClause`), and a scope line inside a create dialog
 * (`CreateScopeLine`). Same icons as the switcher rows, so the clause and
 * the control read as the same fact.
 *
 * All of it disappears for a caller with no teams: workspace furniture on a
 * solo account would name a choice that does not exist — the same rule that
 * hides the switcher itself (`WorkspaceSwitcher` renders nothing below two
 * options).
 */
import { User, Users } from "lucide-react";
import type { TeamSummary } from "@valet/api/wire";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { Tooltip } from "~/components/primitives";
import { useWorkspaceScope } from "~/lib/workspace-scope";

export type ActiveWorkspace =
  | { kind: "personal"; hasTeams: boolean }
  | { kind: "team"; team: TeamSummary };

/**
 * Which workspace the scope names, resolved against what is known.
 *
 * `undefined` while the team list is still loading and the scope names a
 * team — rendering "Personal" in that window would claim a workspace the
 * reader did not choose. A team id the list does not carry resolves to
 * personal: the scope provider is about to heal the stored key the same way
 * (`resolveWorkspaceKey`), and the clause must not outlive the control.
 */
export function resolveActiveWorkspace(args: {
  teamId: string | undefined;
  teams: TeamSummary[] | undefined;
  organizationsEnabled: boolean | undefined;
}): ActiveWorkspace | undefined {
  const known = args.teams !== undefined && args.organizationsEnabled !== undefined;
  const teams = known
    ? eligibleTeams(args.teams, args.organizationsEnabled)
    : undefined;
  if (args.teamId === undefined) {
    return { kind: "personal", hasTeams: (teams?.length ?? 0) > 0 };
  }
  if (teams === undefined) return undefined;
  const team = teams.find((t) => t.id === args.teamId);
  return team ? { kind: "team", team } : { kind: "personal", hasTeams: teams.length > 0 };
}

export function useActiveWorkspace(): ActiveWorkspace | undefined {
  const scope = useWorkspaceScope();
  const teamsQ = useTeams();
  const orgQ = useOrg();
  return resolveActiveWorkspace({
    teamId: scope.teamId,
    teams: teamsQ.data?.teams,
    organizationsEnabled: orgQ.data?.features.organizations,
  });
}

/** The workspace as a sentence fragment: "Engineering", or "your personal
 * workspace". For empty states and dialog copy, so every surface conjugates
 * the same way. */
export function workspaceName(ws: ActiveWorkspace): string {
  return ws.kind === "team" ? ws.team.name : "your personal workspace";
}

/**
 * A quiet clause beside a page title: the workspace's icon and name.
 *
 * Renders nothing for a caller with no teams, and nothing while a
 * team-scoped clause cannot be named yet — a beat of absence beats a wrong
 * name (`resolveActiveWorkspace`).
 */
export function WorkspaceClause() {
  const ws = useActiveWorkspace();
  if (ws === undefined) return null;
  if (ws.kind === "personal") {
    if (!ws.hasTeams) return null;
    return (
      <Tooltip content="Your personal workspace. Only you can see these.">
        <span className="inline-flex items-center gap-1 text-sm font-normal text-muted">
          <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Personal
        </span>
      </Tooltip>
    );
  }
  const count = ws.team.memberCount;
  return (
    <Tooltip content={`Shared with ${count} ${count === 1 ? "person" : "people"} on ${ws.team.name}.`}>
      <span className="inline-flex items-center gap-1 text-sm font-normal text-muted">
        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {ws.team.name}
      </span>
    </Tooltip>
  );
}

/**
 * The scope line inside a create dialog: where the thing is born, stated
 * rather than asked. The switcher already answered; a second owner dropdown
 * here would ask again (see `workspace-scope.tsx`).
 *
 * `what` is the noun the dialog creates ("session", "subscription").
 */
export function CreateScopeLine({ what }: { what: string }) {
  const ws = useActiveWorkspace();
  if (ws === undefined) return null;
  if (ws.kind === "personal") {
    if (!ws.hasTeams) return null;
    return (
      <p className="flex items-center gap-2 rounded border border-line bg-ink-wash/40 px-3 py-2 text-xs text-muted">
        <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          This {what} stays in your personal workspace. Switch workspace in the top bar to
          create it in a team.
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 rounded border border-line bg-ink-wash/40 px-3 py-2 text-xs text-muted">
      <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        This {what} belongs to <span className="font-medium text-ink">{ws.team.name}</span>.
        Everyone on the team can see it.
      </span>
    </p>
  );
}
