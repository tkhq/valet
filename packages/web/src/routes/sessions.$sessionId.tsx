import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { OrchestratorChildSummary } from "@valet/api/wire";
import { useOrchestratorChildren, useOrchestratorInfo } from "~/api/orchestrator";
import { useSession } from "~/api/queries";
import { SecuritySessionLayout } from "~/components/security/engagement-panel";
import { SessionView } from "~/components/session/session-view";
import type { SandboxTabId } from "~/components/session/sandbox-tabs";

const TAB_VALUES: readonly string[] = ["chat", "terminal", "vscode"] satisfies SandboxTabId[];

interface SessionSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
  /** Active view tab. Defaults to "chat" (Task 7 — Terminal/VS Code tabs). */
  tab?: SandboxTabId;
  /** Finding to preselect in the security panel — the Copy-permalink param
   * (valet-security design §Findings review). */
  finding?: string;
}

export const Route = createFileRoute("/sessions/$sessionId")({
  validateSearch: (raw): SessionSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    tab:
      typeof raw.tab === "string" && TAB_VALUES.includes(raw.tab)
        ? (raw.tab as SandboxTabId)
        : undefined,
    finding: typeof raw.finding === "string" ? raw.finding : undefined,
  }),
  component: SessionPage,
});

/** Pure: does this session id appear in the assistant's children list? */
export function findChild(
  children: OrchestratorChildSummary[],
  sessionId: string,
): OrchestratorChildSummary | undefined {
  return children.find((c) => c.sessionId === sessionId);
}

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { thread, tab, finding } = Route.useSearch();
  const navigate = Route.useNavigate();
  const childrenQ = useOrchestratorChildren();
  const info = useOrchestratorInfo();
  // Read the session kind: `kind === "security"` swaps in the engagement
  // panel layout. The query is shared with SessionView's own read, so this
  // adds no request.
  const session = useSession(sessionId);

  // The assistant's own session lives at `/chat`, not this standalone
  // session route. Notification/activity hrefs built server-side (see
  // `packages/api`'s attention-wiring) still point `/sessions/{orchestratorId}`
  // at this route, so redirect here rather than changing the API — this
  // future-proofs any such link regardless of where it originates.
  if (info.data?.sessionId && info.data.sessionId === sessionId) {
    // Forward the thread. This route already validates a `thread` param and
    // /chat already reads one, but the redirect used to drop it — so a link
    // naming a specific thread (a workflow run's, say) landed on whichever
    // thread happened to be newest.
    return <Navigate to="/chat" replace search={thread ? { thread } : {}} />;
  }

  const child = findChild(childrenQ.data?.children ?? [], sessionId);

  const sessionView = (
    <SessionView
      sessionId={sessionId}
      activeThreadId={thread}
      activeTab={tab ?? "chat"}
      onTabChange={(next) => navigate({ search: (prev) => ({ ...prev, tab: next }) })}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {child && <ChildBreadcrumb name={info.data?.name ?? "your assistant"} />}
      {/* Standalone page (decision 14): no thread sidebar, full header —
          the root layout hides the sidebar for this route (see
          `__root.tsx`). Children opened full-page render the same way, with
          the breadcrumb above as their only visual distinction. */}
      {session.data?.kind === "security" ? (
        // Security sessions add the engagement panel beside the chat
        // (valet-security design §engagement panel); every other kind keeps
        // the layout exactly as it was.
        <SecuritySessionLayout sessionId={sessionId} initialFindingId={finding} chat={sessionView} />
      ) : (
        sessionView
      )}
    </div>
  );
}

function ChildBreadcrumb({ name }: { name: string }) {
  return (
    <Link
      to="/chat"
      className="flex items-center gap-1.5 border-b border-line bg-neutral-50 px-4 py-2 text-xs text-muted hover:text-moss dark:bg-neutral-900/40"
    >
      <ArrowLeft className="h-3 w-3" aria-hidden />
      spawned by {name} · back to chat
    </Link>
  );
}
