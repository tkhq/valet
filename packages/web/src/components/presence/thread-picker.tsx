/**
 * ThreadPicker: a searchable list of a workspace's open assistant threads,
 * newest first, each with its title and last activity. The **Runs in**
 * control uses it for the `existing` policy (docs/specs/2026-10-16-presence-hub-design.md
 * Part C step 2).
 *
 * The assistant session comes from the workspace's owner conversation, the
 * same ensure the thread rail uses. The search runs on the server and on the
 * loaded rows, so a typed filter applies at once.
 */
import { useQuery } from "@tanstack/react-query";
import type { ThreadSummary } from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import { useState } from "react";
import { api } from "~/api/client";
import { Input } from "~/components/primitives";
import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { useOwnerConversation } from "~/hooks/use-workspace-conversation";
import { errorText } from "~/lib/error-text";
import { relativeTime } from "~/lib/relative-time";

const UNTITLED = "Untitled thread";

/** Open threads only, newest user activity first. */
export function pickableThreads(threads: readonly ThreadSummary[], query: string): ThreadSummary[] {
  const needle = query.trim().toLowerCase();
  return threads
    .filter((t) => t.archivedAt === undefined)
    .filter((t) => needle.length === 0 || (t.title ?? UNTITLED).toLowerCase().includes(needle))
    .sort((a, b) => b.lastUserActivityAt - a.lastUserActivityAt);
}

export function ThreadPicker({
  workspace,
  selectedThreadId,
  onPick,
}: {
  /** The workspace key (`user` or a team id) whose assistant threads to list. */
  workspace: string;
  selectedThreadId?: string;
  onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>, title: string) => void;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 200);
  const conversation = useOwnerConversation(workspace);
  const sessionId = conversation.data?.sessionId;
  const threadsQ = useQuery({
    queryKey: ["thread-picker", sessionId, debounced],
    enabled: sessionId !== undefined,
    queryFn: () => {
      if (sessionId === undefined) throw new Error("Open the workspace's assistant first.");
      return api.listThreads(sessionId, { q: debounced || undefined, limit: 50, sort: "last-user-activity" });
    },
    placeholderData: (previous) => previous,
  });
  const rows = pickableThreads(threadsQ.data?.threads ?? [], query);
  const failure = conversation.error ?? threadsQ.error;
  const loading = conversation.isLoading || threadsQ.isLoading;

  return (
    <div className="space-y-1.5">
      <Input
        aria-label="Search threads"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search threads…"
      />
      <div role="listbox" aria-label="Threads" className="max-h-52 overflow-auto rounded-md border border-line bg-paper py-1">
        {failure !== null && failure !== undefined && (
          <p role="alert" className="px-2 py-1 text-xs text-danger-500">{errorText(failure)}</p>
        )}
        {failure == null && loading && <p className="px-2 py-1 text-xs text-muted">Loading threads…</p>}
        {failure == null && !loading && rows.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted">
            {query.trim().length > 0 ? "No open thread matches. Change the search." : "This workspace has no open threads."}
          </p>
        )}
        {rows.map((t) => {
          const title = t.title ?? UNTITLED;
          const picked = t.id === selectedThreadId;
          return (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={picked}
              onClick={() => onPick({ mode: "existing", sessionId: t.sessionId, threadId: t.id }, title)}
              className={`flex min-h-11 w-full items-baseline justify-between gap-2 px-2 py-1 text-left text-sm text-ink hover:bg-hover sm:min-h-0 ${picked ? "bg-hover" : ""}`}
            >
              <span className="min-w-0 truncate">{picked ? "✓ " : ""}{title}</span>
              <span className="shrink-0 text-xs text-muted">{relativeTime(t.lastUserActivityAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
