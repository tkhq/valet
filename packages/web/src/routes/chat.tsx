import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useEnsureOrchestrator, useOrchestratorInfo } from "~/api/orchestrator";
import { useEnsureTeamOrchestrator, useOrg, useTeams } from "~/api/settings";
import { useInvalidateMessagesOnQueueState } from "~/hooks/use-invalidate-messages-on-queue-state";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { teamOrchestratorSessionId } from "~/lib/orchestrator-id";
import { Spinner } from "~/components/primitives";

interface ChatSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
  /** Open child session id — renders `ChildPanel` as a slide-over. */
  child?: string;
  /** Talk to this team's assistant instead of your own. Absent = your own. */
  team?: string;
}

/**
 * `/chat` — the assistant conversation (assistant-centered web UI,
 * decision 1/12/13). Mounts the shared `SessionView`; the sidebar (`AssistantRail`: every assistant you can reach, then the
 * active one's threads) is swapped in by the root layout for this route
 * (see `__root.tsx`), not rendered here.
 *
 * `?team=` selects a team's assistant. The session id is derived, not
 * fetched — see `lib/orchestrator-id.ts` — so linking here from anywhere
 * (the rail, an owner badge, the teams settings panel) costs nothing until
 * someone actually opens the conversation.
 */
export const Route = createFileRoute("/chat")({
  validateSearch: (raw): ChatSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
    team: typeof raw.team === "string" ? raw.team : undefined,
  }),
  component: ChatPage,
});

function ChatPage() {
  const { thread, child, team } = Route.useSearch();
  const info = useOrchestratorInfo();
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const navigate = useNavigate({ from: Route.fullPath });
  const ensure = useEnsureOrchestrator();
  const ensureTeam = useEnsureTeamOrchestrator();

  // Only a team the caller belongs to may be opened. A stale or hand-edited
  // id resolves to nothing and falls back to the personal assistant, rather
  // than mounting a session the viewer cannot read.
  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const scopeResolved = teamsQ.data !== undefined && orgQ.data !== undefined;
  const activeTeam = team !== undefined ? teams.find((t) => t.id === team) : undefined;
  const unavailableTeam = team !== undefined && scopeResolved && activeTeam === undefined;

  const personalSessionId = info.data?.sessionId;
  const sessionId = activeTeam ? teamOrchestratorSessionId(activeTeam.id) : personalSessionId;

  // Neither `GET /info` nor the derived team id creates an engine session
  // (decision 20 / brief), so ensure the active one exists before
  // SessionView tries to open it. Both calls are idempotent.
  const activeTeamId = activeTeam?.id;
  useEffect(() => {
    if (activeTeamId) ensureTeam.mutate(activeTeamId);
    else if (personalSessionId) ensure.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeamId, personalSessionId]);

  // CRITICAL (Task 1 flag): signal entries (e.g. child.settled) only reach
  // the client via REST — no live WS event carries the signal payload.
  // `useMessages` has background refetch disabled, so without this the
  // chat page would never show a new signal until manually reloaded.
  useInvalidateMessagesOnQueueState(sessionId, thread);

  function closeChild() {
    navigate({ search: (prev) => ({ ...prev, child: undefined }) });
  }

  function openChild(childId: string) {
    navigate({ search: (prev) => ({ ...prev, child: childId }) });
  }

  // A requested team is unresolved until both queries land. Showing the
  // personal assistant in the meantime would flash the wrong conversation.
  if (team !== undefined && !scopeResolved) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (!activeTeam && info.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (!activeTeam && (info.error || !sessionId)) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn't load your assistant.
          <div className="mt-2">
            <button type="button" className="underline" onClick={() => info.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!sessionId) return null;

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTeam && (
          <ScopeNotice>
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Shared with {activeTeam.memberCount}{" "}
              {activeTeam.memberCount === 1 ? "person" : "people"} on{" "}
              <span className="font-medium text-ink">{activeTeam.name}</span>. Everyone on the
              team can read this conversation and reply.
            </span>
          </ScopeNotice>
        )}
        {unavailableTeam && (
          <ScopeNotice>
            <span>
              That team's assistant isn't available to you. Showing your own assistant instead.
            </span>
          </ScopeNotice>
        )}
        <SessionView
          sessionId={sessionId}
          activeThreadId={thread}
          onOpenChild={openChild}
        />
      </div>
      {child && <ChildPanel childId={child} onClose={closeChild} />}
    </>
  );
}

/** A hairline strip directly above the conversation. It sits here rather
 * than inside `SessionView` so it reads as context for what you are about
 * to type, not as a property of the session. */
function ScopeNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line bg-ink-wash/40 px-4 py-1.5 text-xs text-muted">
      {children}
    </div>
  );
}
