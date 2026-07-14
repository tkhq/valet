import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useSessions } from "~/api/queries";
import { Button, Spinner } from "~/components/primitives";
import { NewSessionDialog } from "~/components/new-session-dialog";

/**
 * Stub `/sessions` list (Task 3). Full standalone-only filtering + card
 * layout land in Task 4 (decision 1/8) — for now this keeps the "Sessions"
 * nav link and the "New session" action (moved out of the top nav per
 * decision 9/assistant-first IA) working against the existing session
 * list.
 */
export const Route = createFileRoute("/sessions")({
  component: SessionsPage,
});

function SessionsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const { data, isLoading, error } = useSessions();
  const sessions = data?.sessions ?? [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Sessions</h1>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="h-4 w-4" />
          <span>New session</span>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={14} /> Loading sessions…
          </div>
        )}
        {!isLoading && error && (
          <div className="text-sm text-danger-500">Failed to load sessions.</div>
        )}
        {!isLoading && !error && sessions.length === 0 && (
          <div className="text-sm text-muted">
            Standalone sessions are for direct work and automation — create one.
          </div>
        )}
        {!isLoading && sessions.length > 0 && (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: s.id }}
                  className="flex flex-col gap-0.5 rounded border border-line bg-paper px-4 py-3 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  <span className="text-sm font-medium text-ink truncate">
                    {s.title || "Untitled session"}
                  </span>
                  <span className="text-xs text-muted font-mono truncate">{s.workspace}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
