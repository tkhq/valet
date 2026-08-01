import { createFileRoute } from "@tanstack/react-router";
import { useMemoryTree } from "~/api/memory";
import { useOrchestratorInfo } from "~/api/orchestrator";

/**
 * `/memory` index child — the explorer's resting state (Task 6 brief,
 * decision 17): an empty doc pane with a hint, or spec-verbatim empty-state
 * copy when nothing's been remembered yet. The tree/search pane is owned by
 * the parent layout (`memory.tsx`); this route only renders the right pane.
 */
export const Route = createFileRoute("/memory/")({
  component: MemoryIndexPage,
});

function MemoryIndexPage() {
  const treeQ = useMemoryTree();
  const info = useOrchestratorInfo();
  const name = info.data?.name ?? "your assistant";

  const nothingRemembered = treeQ.data !== undefined && treeQ.data.entries.length === 0;

  return (
    <main className="flex flex-1 min-h-0 items-center justify-center p-8 text-center text-sm text-muted">
      {nothingRemembered ? (
        <p>Nothing remembered yet. Talk to {name}, or use Import in the left pane to load a memory bundle.</p>
      ) : (
        <p>Select a file from the tree to read it.</p>
      )}
    </main>
  );
}
