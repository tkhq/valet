import { useCallback, useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useEnsureOrchestrator, useOrchestratorInfo } from "~/api/orchestrator";
import { useAssistants, useEnsureAssistantSession } from "~/api/assistants";
import { useOrg, useTeams } from "~/api/settings";
import { useInvalidateMessagesOnQueueState } from "~/hooks/use-invalidate-messages-on-queue-state";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import {
  eligibleTeams,
  findAssistant,
  groupAssistants,
  ownDefaultAssistant,
  scopedDefaultAssistant,
} from "~/components/session/assistant-rail";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { Spinner } from "~/components/primitives";

interface ChatSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
  /** Open child session id — renders `ChildPanel` as a slide-over. */
  child?: string;
  /**
   * Which assistant to talk to. Absent = your own default, which is what an
   * absent `?team=` meant before a principal could own several.
   *
   * It carries the assistant id, not the session id. The address scheme
   * (`assistant:{id}`) is the server's to change, and every consumer is
   * meant to learn a session id from `GET /api/assistants` rather than build
   * one — a link that carried the address would bake the scheme into every
   * bookmark. The id is also the shorter, colon-free half of the pair.
   */
  assistant?: string;
}

/**
 * `/chat` — the assistant conversation (assistant-centered web UI,
 * decision 1/12/13). Mounts the shared `SessionView`; the sidebar
 * (`AssistantRail`: every assistant you can reach, then the active one's
 * threads) is swapped in by the root layout for this route (see
 * `__root.tsx`), not rendered here.
 *
 * `?assistant=` selects one. The session id comes from the assistants list,
 * which the rail already reads, so linking here from anywhere (the rail, an
 * owner badge, the teams settings panel) still creates nothing until someone
 * opens the conversation.
 */
export const Route = createFileRoute("/chat")({
  validateSearch: (raw): ChatSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
    assistant: typeof raw.assistant === "string" ? raw.assistant : undefined,
  }),
  component: ChatPage,
});

function ChatPage() {
  const { thread, child, assistant } = Route.useSearch();
  const info = useOrchestratorInfo();
  const assistantsQ = useAssistants();
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = useWorkspaceScope();
  const ensure = useEnsureOrchestrator();
  const ensureAssistantSession = useEnsureAssistantSession();
  // Session ids this page has confirmed exist, so it never mounts the
  // conversation on one that is still being created. `POST /api/assistants`
  // writes no session, so the read below would 404 and `SessionView` renders
  // that as a terminal "Failed to load session" with no retry — the first
  // thing you see after creating an assistant. Nothing recovers it, because
  // the read already resolved; only a reload does. Waiting for the ensure is
  // deterministic where invalidating after the fact is a race.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const markOpened = useCallback(
    ({ sessionId: id }: { sessionId: string }) =>
      setOpened((prev) => (prev.has(id) ? prev : new Set(prev).add(id))),
    [],
  );

  // Only an assistant the caller can reach may be opened. An id that names
  // an archived assistant, a team you left, or nothing at all resolves to
  // undefined and falls back to your own default, rather than mounting a
  // session the viewer cannot read.
  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const groups = groupAssistants(assistantsQ.data?.assistants, teams);
  const scopeResolved =
    teamsQ.data !== undefined && orgQ.data !== undefined && assistantsQ.data !== undefined;
  const listFailed = assistantsQ.error != null;
  const active = findAssistant(groups, assistant);
  // Two different facts, two different messages: the list says this
  // assistant is not yours to open, or the list never arrived.
  const unavailable = assistant !== undefined && scopeResolved && active === undefined;
  const unresolved = assistant !== undefined && listFailed;

  // `GET /api/orchestrator/info` stays the fallback for your own default:
  // it answers before the list does on a cold load, and it still answers if
  // the list fails, so a broken assistants call costs you the switcher
  // rather than the conversation.
  const ownDefault = ownDefaultAssistant(groups);
  // With no `?assistant=`, open the ACTIVE workspace's default assistant, so
  // arriving at `/chat` with a team already in scope shows that team's
  // conversation — not your personal one (the reported bug). Falls back to
  // your own default when the scoped workspace owns no assistant, or on a
  // cold load before the list lands (`info` answers first).
  const scopedDefault = scopedDefaultAssistant(groups, scope.key);
  const fallback = scopedDefault ?? ownDefault;
  const personalSessionId = fallback?.sessionId ?? info.data?.sessionId;
  const sessionId = active?.sessionId ?? personalSessionId;

  // Canonicalize the URL to the scoped team default so the sidebar highlight,
  // the "shared with the team" notice and any `?child=` all resolve to the
  // opened assistant — the same move the workspace switcher makes when you
  // pick a team from `/chat`. Personal scope keeps the param-less URL (its
  // default IS the fallback), and a team that owns no assistant leaves
  // `scopedDefault` undefined, so this fires once, only for a real team
  // assistant, after the list resolves.
  useEffect(() => {
    if (assistant === undefined && scopeResolved && scope.teamId && scopedDefault) {
      navigate({ replace: true, search: (prev) => ({ ...prev, assistant: scopedDefault.id }) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant, scopeResolved, scope.teamId, scopedDefault?.id]);

  const team =
    active?.owner.type === "team"
      ? teams.find((t) => t.id === active.owner.id)
      : undefined;

  // Neither the list nor `GET /info` creates an engine session (decision 20
  // / the assistants design), so ensure the active one exists before
  // SessionView tries to open it. Every call here is idempotent.
  //
  // One call for every assistant, default or not: `POST
  // /api/assistants/:id/session` is addressed by assistant, so nothing here
  // branches on which one is default or who owns it. The owner-addressed
  // routes remain the fallback for exactly one case — a cold load where the
  // assistants list has not arrived, so there is no id to send yet and only
  // `GET /info` knows the caller's own session.
  const activeId = active?.id ?? fallback?.id;
  useEffect(() => {
    if (activeId) ensureAssistantSession.mutate(activeId, { onSuccess: markOpened });
    else if (personalSessionId) ensure.mutate(undefined, { onSuccess: markOpened });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, personalSessionId]);

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

  // A requested assistant is unresolved until the queries land. Showing your
  // own in the meantime would flash the wrong conversation.
  if (assistant !== undefined && !scopeResolved && !listFailed) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (!active && info.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (!active && (info.error || !sessionId)) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn’t load your assistant.
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

  // The ensure for this session has not come back yet. A spinner for the few
  // milliseconds it takes beats an error the page cannot clear.
  if (!opened.has(sessionId)) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Opening…
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        {team && (
          <ScopeNotice>
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Shared with {team.memberCount} {team.memberCount === 1 ? "person" : "people"} on{" "}
              <span className="font-medium text-ink">{team.name}</span>. Everyone on the team can
              read this conversation and reply.
            </span>
          </ScopeNotice>
        )}
        {unavailable && (
          <ScopeNotice>
            <span>
              That assistant is not available to you. Showing your own assistant instead. Select
              another one in the sidebar.
            </span>
          </ScopeNotice>
        )}
        {unresolved && (
          <ScopeNotice>
            <span>
              Cannot load your assistants, so this one cannot be opened. Showing your own assistant
              instead. Reload the page.
            </span>
          </ScopeNotice>
        )}
        <SessionView sessionId={sessionId} activeThreadId={thread} onOpenChild={openChild} />
      </div>
      {child && <ChildPanel childId={child} onClose={closeChild} />}
    </>
  );
}

/** A hairline strip directly above the conversation. It sits here rather
 * than inside `SessionView` so it reads as context for what you are about
 * to type, not as a property of the session.
 *
 * `role="status"` because every notice appears after its queries settle: the
 * strip pushes into a page the screen reader has already read, and who else
 * can read the conversation is not something to learn by looking. Polite,
 * not `alert` — the notice adds context, it does not stop the work. */
function ScopeNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-line bg-ink-wash/40 px-4 py-1.5 text-xs text-muted"
    >
      {children}
    </div>
  );
}
