import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { OrchestratorChildSummary } from "@valet/api/wire";
import { useOrchestratorChildren, useOrchestratorInfo } from "~/api/orchestrator";
import { SessionView } from "~/components/session/session-view";

interface SessionSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
}

export const Route = createFileRoute("/sessions/$sessionId")({
  validateSearch: (raw): SessionSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
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
  const { thread } = Route.useSearch();
  const childrenQ = useOrchestratorChildren();
  const info = useOrchestratorInfo();

  const child = findChild(childrenQ.data?.children ?? [], sessionId);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {child && <ChildBreadcrumb name={info.data?.name ?? "your assistant"} />}
      {/* Standalone variant (decision 14): no thread sidebar, full header —
          the root layout hides the sidebar for this route (see
          `__root.tsx`). Children opened full-page render the same way, with
          the breadcrumb above as their only visual distinction. */}
      <SessionView sessionId={sessionId} variant="standalone" activeThreadId={thread} />
    </div>
  );
}

function ChildBreadcrumb({ name }: { name: string }) {
  return (
    <Link
      to="/chat"
      className="flex items-center gap-1.5 border-b border-line bg-neutral-50 px-4 py-2 text-xs text-muted hover:text-moss dark:bg-neutral-900/40"
    >
      <ArrowLeft className="h-3 w-3" />
      spawned by {name} · back to chat
    </Link>
  );
}
