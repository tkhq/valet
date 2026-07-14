import { Link } from "@tanstack/react-router";
import { ApiError } from "~/api/client";
import { useMemoryDoc, useMemoryTree } from "~/api/memory";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { Spinner } from "~/components/primitives";

/** Pure — UTC date, matches the server's `journal/YYYY-MM-DD.md` convention
 * (`packages/api/src/orchestrator/bootstrap.ts` `todayJournalPath`). */
export function todayJournalPath(now: Date = new Date()): string {
  return `journal/${now.toISOString().slice(0, 10)}.md`;
}

/** Pure excerpt derivation, testable without a query. */
export function journalExcerpt(content: string, maxChars = 220): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

/**
/**
 * Dashboard memory card (decision 15): pinned files + today's journal
 * excerpt. Self-contained — owns the tree query and the journal doc fetch,
 * degrades per-section rather than blanking. Links target the Task 6
 * explorer's splat route (`/memory/$`, param `_splat` — the file path)
 * via the typed router `Link` for client-side navigation.
 */
export function MemoryCard() {
  const info = useOrchestratorInfo();
  const name = info.data?.name ?? "your assistant";
  const treeQ = useMemoryTree();
  const journalPath = todayJournalPath();
  const journalQ = useMemoryDoc(journalPath);

  const pinned = (treeQ.data?.entries ?? []).filter((e) => e.pinned);
  const journalNotFound = journalQ.error instanceof ApiError && journalQ.error.status === 404;
  const journalOtherError = !!journalQ.error && !journalNotFound;

  const treeEmpty = treeQ.data !== undefined && treeQ.data.entries.length === 0;
  const nothingRemembered = treeEmpty && journalNotFound;

  return (
    <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex items-center justify-between">
        <h2 className="font-display text-base text-ink">
          <Link to="/memory" className="hover:text-moss">
            Memory
          </Link>
        </h2>
        <Link to="/memory" className="text-xs text-muted hover:text-moss">
          Browse
        </Link>
      </header>

      <div className="flex-1 px-4 py-3 space-y-4 overflow-y-auto max-h-64">
        {treeQ.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {treeQ.error && (
          <div className="text-xs text-danger-500">
            Couldn't load memory.{" "}
            <button type="button" className="underline" onClick={() => treeQ.refetch()}>
              Retry
            </button>
          </div>
        )}

        {nothingRemembered && (
          <p className="text-sm text-muted">
            Nothing remembered yet. Talk to {name}, or import a bundle via the API.
          </p>
        )}

        {!treeQ.isLoading && !treeQ.error && !nothingRemembered && (
          <>
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-muted">Pinned</h3>
              {pinned.length === 0 ? (
                <p className="text-xs text-muted">Nothing pinned yet.</p>
              ) : (
                <ul className="space-y-1">
                  {pinned.map((f) => (
                    <li key={f.path}>
                      <Link
                        to="/memory/$"
                        params={{ _splat: f.path }}
                        className="text-sm text-ink hover:text-moss hover:underline"
                      >
                        📌 {f.title || f.path}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-1">
              <h3 className="text-xs font-medium text-muted">Today's journal</h3>
              {journalQ.isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Spinner size={14} /> Loading…
                </div>
              )}
              {journalNotFound && <p className="text-xs text-muted">No journal entry yet today.</p>}
              {journalOtherError && (
                <div className="text-xs text-danger-500">
                  Couldn't load today's journal.{" "}
                  <button type="button" className="underline" onClick={() => journalQ.refetch()}>
                    Retry
                  </button>
                </div>
              )}
              {journalQ.data?.kind === "file" && journalQ.data.file && (
                <Link
                  to="/memory/$"
                  params={{ _splat: journalPath }}
                  className="block text-sm text-ink hover:text-moss"
                >
                  {journalExcerpt(journalQ.data.file.content)}
                </Link>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
