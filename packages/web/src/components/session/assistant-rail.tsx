import { Link, useSearch } from "@tanstack/react-router";
import { Bot, Users } from "lucide-react";
import type { TeamSummary } from "@valet/api/wire";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useOrg, useTeams } from "~/api/settings";
import { Tooltip } from "~/components/primitives";
import { teamOrchestratorSessionId } from "~/lib/orchestrator-id";
import { cn } from "~/lib/cn";
import { ThreadTree } from "./thread-tree";

/**
 * The `/chat` sidebar: every assistant you can talk to, then the threads of
 * whichever one is active.
 *
 * A team's assistant used to be reachable only through Settings ›
 * Organization › Teams — a configuration screen, three clicks deep, behind
 * an org-admin gate that most members fail. Teams are not a setting; they
 * are how work is addressed. So each team you belong to gets a permanent
 * row here, as a sibling of your own assistant, and finding your team's
 * assistant is the same act as finding your own.
 *
 * Rows are plain links. `teamOrchestratorSessionId` derives the well-known
 * session id client-side, so browsing the rail creates nothing — `/chat`
 * materializes the session only when you actually open the conversation.
 */
export function AssistantRail() {
  const orgQ = useOrg();
  const teamsQ = useTeams();
  const search = (useSearch({ strict: false }) ?? {}) as { team?: string };

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);

  // No-flash rule (same as `settings-rail.tsx`): both queries must resolve
  // before the block can appear. A section that renders and then vanishes
  // is worse than one that arrives a beat late.
  const resolved = orgQ.data !== undefined && teamsQ.data !== undefined;
  const showAssistants = resolved && teams.length > 0;

  // Only a team the caller actually belongs to may drive the thread tree —
  // a stale or hand-edited `?team=` falls back to the personal assistant
  // rather than rendering a session the viewer cannot read.
  const activeTeam = teams.find((t) => t.id === search.team);

  return (
    <>
      {showAssistants && (
        <div className="border-b border-line pb-2 pt-2">
          <p className="px-4 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted">
            Assistants
          </p>
          <PersonalAssistantRow active={activeTeam === undefined} />
          {teams.map((team) => (
            <TeamAssistantRow key={team.id} team={team} active={activeTeam?.id === team.id} />
          ))}
        </div>
      )}
      {activeTeam ? (
        // Children are deliberately omitted in team scope:
        // `GET /api/orchestrator/children` resolves the CALLER's own
        // orchestrator, so rendering them here would nest your personal
        // child sessions under the team's threads — wrong, not merely
        // absent. Threads themselves work fully.
        <ThreadTree sessionId={teamOrchestratorSessionId(activeTeam.id)} showChildren={false} />
      ) : (
        <ThreadTree />
      )}
    </>
  );
}

/** Teams whose assistant the caller may open: the org feature gate is on,
 * and they are a member. An org admin sees every team in the org from
 * `GET /api/teams`, so membership alone is not the test — `callerRole` is
 * null for a team they only administer. */
export function eligibleTeams(
  teams: TeamSummary[] | undefined,
  organizationsEnabled: boolean | undefined,
): TeamSummary[] {
  if (organizationsEnabled !== true) return [];
  return (teams ?? []).filter((t) => t.callerRole !== null);
}

function PersonalAssistantRow({ active }: { active: boolean }) {
  const info = useOrchestratorInfo();
  const name = info.data?.name || "Your assistant";

  return (
    <AssistantRow
      to={{ team: undefined }}
      icon={<Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      label={name}
      active={active}
    />
  );
}

function TeamAssistantRow({ team, active }: { team: TeamSummary; active: boolean }) {
  return (
    <Tooltip
      content={`${team.name} — shared with ${team.memberCount} ${team.memberCount === 1 ? "person" : "people"}`}
      delayDuration={600}
    >
      <AssistantRow
        to={{ team: team.id }}
        icon={<Users className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        label={team.name}
        active={active}
      />
    </Tooltip>
  );
}

function AssistantRow({
  to,
  icon,
  label,
  active,
}: {
  to: { team: string | undefined };
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      to="/chat"
      // Switching assistant clears thread and child: they are ids scoped to
      // the session you are leaving, and carrying them across would point
      // at threads that do not exist on the one you are opening.
      search={{ team: to.team, thread: undefined, child: undefined }}
      className={cn(
        "flex items-center gap-2 pr-4 py-1.5 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:bg-ink-wash",
        active
          ? "bg-moss-wash-strong text-ink border-l-2 border-moss pl-[calc(1rem-2px)] font-medium"
          : "text-ink/85 hover:bg-ink-wash/60 pl-4 border-l-2 border-transparent",
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
    </Link>
  );
}
