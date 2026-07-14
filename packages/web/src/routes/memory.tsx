import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemoryTree } from "~/api/memory";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { MemorySearchPane } from "~/components/memory/memory-search";

/**
 * `/memory` — the explorer's resting state (Task 6 brief, decision 17):
 * tree in the left pane, an empty doc pane with a hint on the right. No
 * app sidebar for memory routes — the tree pane below IS the left pane
 * (see `__root.tsx`'s `sidebarForPath`, which doesn't special-case
 * `/memory*` and so falls through to the default `ThreadList`... actually
 * handled by not rendering `<aside>` content here at all; the explorer
 * owns its full two-pane layout inside `<main>`).
 */
export const Route = createFileRoute("/memory")({
  component: MemoryIndexPage,
});

function MemoryIndexPage() {
  const navigate = useNavigate();
  const treeQ = useMemoryTree();
  const info = useOrchestratorInfo();
  const name = info.data?.name ?? "your assistant";

  function onSelect(path: string) {
    void navigate({ to: "/memory/$", params: { _splat: path } });
  }

  const nothingRemembered = treeQ.data !== undefined && treeQ.data.entries.length === 0;

  return (
    <div className="flex flex-1 min-h-0">
      <aside className="w-72 shrink-0 border-r border-line">
        <MemorySearchPane onSelect={onSelect} />
      </aside>
      <main className="flex flex-1 min-h-0 items-center justify-center p-8 text-center text-sm text-muted">
        {nothingRemembered ? (
          <p>Nothing remembered yet. Talk to {name}, or import a bundle via the API.</p>
        ) : (
          <p>Select a file from the tree to read it.</p>
        )}
      </main>
    </div>
  );
}
