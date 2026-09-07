import { useCallback, useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Users } from "lucide-react";
import type { TeamSummary } from "@valet/api/wire";
import { useEnsureOrchestrator, useOrchestratorInfo } from "~/api/orchestrator";
import { useAssistants, useCreateAssistant, useEnsuredAssistantSession } from "~/api/assistants";
import { useMe, useOrg, useTeams } from "~/api/settings";
import { useInvalidateMessagesOnQueueState } from "~/hooks/use-invalidate-messages-on-queue-state";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import {
  canAdministerGroup,
  chooseChatAssistant,
  eligibleTeams,
  findAssistant,
  groupAssistants,
} from "~/components/session/assistant-rail";
import { Spinner } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { PERSONAL, useWorkspaceScope } from "~/lib/workspace-scope";

interface ChatSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
  /** Open child session id — renders `ChildPanel` as a slide-over. */
  child?: string;
  /**
   * Which assistant to talk to. Absent = the active workspace's default
   * (personal, or the team's). A team with no assistant shows a notice
   * instead of your personal conversation.
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
  const meQ = useMe();
  const scope = useWorkspaceScope();
  const navigate = useNavigate({ from: Route.fullPath });
  const ensure = useEnsureOrchestrator();
  // Session ids the `GET /info` fallback below has confirmed exist, so the
  // page never mounts the conversation on one that is still being created.
  // The read would 404 and `SessionView` renders that as a terminal "Failed
  // to load session" with no retry. Nothing recovers it, because the read
  // already resolved; only a reload does. Waiting for the ensure is
  // deterministic where invalidating after the fact is a race. An assistant
  // chosen from the list goes through `useEnsuredAssistantSession` instead,
  // which the rail shares.
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
  // `/api/me` is part of the gate: the empty-team notice reads the caller's
  // org role to decide between the create action and "ask a team admin",
  // and deciding before it lands shows an org admin the wrong copy.
  const scopeResolved =
    teamsQ.data !== undefined &&
    orgQ.data !== undefined &&
    assistantsQ.data !== undefined &&
    meQ.data !== undefined;
  const listFailed = assistantsQ.error != null;
  const named = findAssistant(groups, assistant);
  const choice = chooseChatAssistant(groups, scope.key, assistant);
  const chosen = choice.kind === "open" || choice.kind === "personal" ? choice.assistant : undefined;
  // Two different facts, two different messages: the list says this
  // assistant is not yours to open, or the list never arrived. The second
  // covers a team workspace as well as a named assistant: without the list
  // there is no team assistant to open, and the page falls back to your
  // own conversation and says so, rather than replacing the page with an
  // error the rail already shows.
  const unavailable = assistant !== undefined && scopeResolved && named === undefined;
  const unresolved = listFailed && (assistant !== undefined || scope.key !== PERSONAL);

  // `GET /api/orchestrator/info` stays the fallback for your own default:
  // it answers before the list does on a cold load, and it still answers if
  // the list fails, so a broken assistants call costs you the switcher
  // rather than the conversation. A team workspace must not use it — that
  // is the silent personal fallback this page used to make.
  const personalSessionId = chosen?.sessionId ?? info.data?.sessionId;
  const sessionId =
    chosen?.sessionId ?? (choice.kind === "personal" ? personalSessionId : undefined);

  const team =
    chosen?.owner.type === "team" ? teams.find((t) => t.id === chosen.owner.id) : undefined;
  const emptyTeam = teams.find((t) => t.id === scope.key);

  const canonicalizeId = choice.kind === "open" && choice.canonicalize ? choice.assistant.id : undefined;
  useEffect(() => {
    if (!canonicalizeId || assistant === canonicalizeId) return;
    void navigate({
      search: (prev) => ({ ...prev, assistant: canonicalizeId }),
      replace: true,
    });
  }, [canonicalizeId, assistant, navigate]);

  // Neither the list nor `GET /info` creates an engine session (decision 20
  // / the assistants design), so ensure the active one exists before
  // SessionView tries to open it. Every call here is idempotent.
  //
  // One call for every assistant, default or not: `POST
  // /api/assistants/:id/session` is addressed by assistant, so nothing here
  // branches on which one is default or who owns it. Since a team's default
  // assistant is seeded as a row alone, the id can name a session no call
  // has created yet, so no read of it may run before this answers — the
  // gate below holds `SessionView` back, and the rail holds its thread tree
  // on the same query. The owner-addressed route remains the fallback for
  // exactly one case — a cold load where the assistants list has not
  // arrived, so there is no id to send yet and only `GET /info` knows the
  // caller's own session.
  const activeId = chosen?.id;
  const ensured = useEnsuredAssistantSession(activeId);
  useEffect(() => {
    if (activeId || choice.kind !== "personal" || !personalSessionId) return;
    ensure.mutate(undefined, { onSuccess: markOpened });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, personalSessionId, choice.kind]);

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

  // A requested assistant, or a team workspace, is unresolved until the
  // queries land. Showing your own in the meantime would flash the wrong
  // conversation.
  const waitingOnTeam = scope.key !== PERSONAL && !scopeResolved && !listFailed;
  if ((assistant !== undefined || waitingOnTeam) && !scopeResolved && !listFailed) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (choice.kind === "empty-team" && scopeResolved && !listFailed) {
    return (
      <EmptyTeamNotice
        team={emptyTeam}
        canAdminister={
          emptyTeam !== undefined &&
          canAdministerGroup(
            { key: emptyTeam.id, label: emptyTeam.name, team: emptyTeam, assistants: [] },
            meQ.data?.orgRole === "admin",
          )
        }
      />
    );
  }

  if (choice.kind === "personal" && !chosen && info.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (choice.kind === "personal" && !chosen && (info.error || !sessionId)) {
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

  if (activeId && ensured.error) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn’t open this assistant. {errorText(ensured.error)}
          <div className="mt-2">
            <button type="button" className="underline" onClick={() => ensured.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // The ensure for this session has not come back yet. A spinner for the few
  // milliseconds it takes beats an error the page cannot clear. `opened`
  // covers the `GET /info` fallback, which can answer before the list does;
  // once the list names the same session, the query's answer is not waited
  // on again, so the conversation stays mounted.
  if (!opened.has(sessionId) && !ensured.isSuccess) {
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
        {unavailable && choice.kind !== "personal" && (
          <ScopeNotice>
            <span>
              That assistant is not available. Showing this workspace's assistant instead. Select
              another one in the sidebar.
            </span>
          </ScopeNotice>
        )}
        {unavailable && choice.kind === "personal" && (
          <ScopeNotice>
            <span>
              That assistant is not available to you. Showing your own assistant instead. Select
              another one in the sidebar.
            </span>
          </ScopeNotice>
        )}
        {unresolved && choice.kind === "personal" && (
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

function EmptyTeamNotice({
  team,
  canAdminister,
}: {
  team: TeamSummary | undefined;
  canAdminister: boolean;
}) {
  const create = useCreateAssistant();
  const navigate = useNavigate({ from: Route.fullPath });
  const place = team?.name ?? "this team";

  function onCreate() {
    if (!team) return;
    create.mutate(
      { owner: { type: "team", id: team.id } },
      {
        onSuccess: (created) =>
          void navigate({
            search: (prev) => ({
              ...prev,
              assistant: created.id,
              thread: undefined,
              child: undefined,
            }),
          }),
      },
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ScopeNotice>
        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          No assistant in {place} yet.
          {canAdminister
            ? ""
            : " Ask a team admin to create one."}
        </span>
        {canAdminister && team && (
          <button
            type="button"
            className="underline"
            onClick={onCreate}
            disabled={create.isPending}
          >
            {create.isPending ? "Creating…" : "Create an assistant"}
          </button>
        )}
      </ScopeNotice>
      {create.error != null && (
        <p className="px-4 py-2 text-xs text-danger-500">{errorText(create.error)}</p>
      )}
    </div>
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
