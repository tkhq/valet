import { useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { Bot, Users } from "lucide-react";
import type { TeamSummary } from "@valet/api/wire";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useNotifications } from "~/api/queries";
import { attentionSessionIds } from "~/lib/use-attention-ping";
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

  // Costs no request: the bell is already polling this query.
  const notificationsQ = useNotifications();
  const needsAttention = attentionSessionIds(notificationsQ.data?.notifications);
  const [showAllTeams, setShowAllTeams] = useState(false);
  const shown = showAllTeams ? teams : visibleTeams(teams, needsAttention);
  const hiddenCount = teams.length - shown.length;

  return (
    <>
      {showAssistants && (
        <div className="border-b border-line pb-2 pt-2">
          <p className="px-4 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted">
            Assistants
          </p>
          <PersonalAssistantRow active={activeTeam === undefined} />
          {shown.map((team) => (
            <TeamAssistantRow
              key={team.id}
              team={team}
              active={activeTeam?.id === team.id}
              needsYou={needsAttention.has(teamOrchestratorSessionId(team.id))}
            />
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllTeams(true)}
              className="w-full pl-4 pr-4 py-1.5 text-left text-xs text-muted transition-colors hover:bg-ink-wash/60 hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none"
            >
              Show {hiddenCount} more
            </button>
          )}
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

/**
 * How many team rows the block shows before it stops growing.
 *
 * Two lists share this column, and without a cap the containers win: at
 * nine teams the Assistants block measured 42% of the sidebar, and it has
 * no scroll of its own, so it squeezes the thread list rather than
 * scrolling. Twenty teams would leave room for about two threads.
 */
const VISIBLE_TEAM_CAP = 5;

/**
 * The teams the block renders, in their given order, plus any team past
 * the cap that is waiting on a person.
 *
 * Order is NOT changed by attention. Pulling a team to the top the moment
 * it needs you would reorder the list under the cursor — the same fault
 * this product avoids in the thread list, where rows move on their own
 * because agents work unattended. A row that moves while you reach for it
 * is worse than a row you have to expand to find.
 *
 * What the cap must never do is hide live work. So the overflow is not a
 * plain `slice`: a team below the fold that is blocked on you comes back
 * into the visible set, keeping its position relative to the others.
 */
export function visibleTeams(
  teams: TeamSummary[],
  needsAttention: ReadonlySet<string>,
  cap: number = VISIBLE_TEAM_CAP,
): TeamSummary[] {
  if (teams.length <= cap) return teams;
  return teams.filter(
    (t, i) => i < cap || needsAttention.has(teamOrchestratorSessionId(t.id)),
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

function TeamAssistantRow({
  team,
  active,
  needsYou,
}: {
  team: TeamSummary;
  active: boolean;
  needsYou: boolean;
}) {
  const shared = `${team.memberCount} ${team.memberCount === 1 ? "person" : "people"}`;
  return (
    <Tooltip
      content={
        needsYou
          ? `${team.name} — waiting on an answer. Shared with ${shared}.`
          : `${team.name} — shared with ${shared}`
      }
      delayDuration={600}
    >
      <AssistantRow
        to={{ team: team.id }}
        icon={<Users className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        label={team.name}
        active={active}
        // A dot, not a count. Slack's grammar: a mark says something
        // changed, a number says it is addressed to you — and a column of
        // numbers reads as noise long before it reads as priority. The
        // count belongs once, on the bell, not on every row.
        trailing={
          needsYou ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-fg"
              aria-label="Waiting on you"
            />
          ) : undefined
        }
      />
    </Tooltip>
  );
}

function AssistantRow({
  to,
  icon,
  label,
  active,
  trailing,
}: {
  to: { team: string | undefined };
  icon: React.ReactNode;
  label: string;
  active: boolean;
  trailing?: React.ReactNode;
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
      {trailing}
    </Link>
  );
}
