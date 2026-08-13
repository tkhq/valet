import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MemoryDoc } from "~/components/memory/memory-doc";

/**
 * `/memory/$` — the explorer's document view. The splat param (`_splat`,
 * TanStack Router's key for a `$`-suffixed catch-all file — see
 * `router-core`'s `path.js`) is the file path, which legitimately contains
 * slashes (`journal/2026-07-13.md`); a plain `$path` param would only
 * capture a single segment, which is why this is a splat route rather than
 * `?path=` (the brief's fallback for when splat routing turns out to be
 * awkward — it wasn't).
 *
 * The tree/search pane is owned by the parent layout (`memory.tsx`); this
 * route only renders the right pane's doc content.
 */
export const Route = createFileRoute("/memory/$")({
  component: MemoryDocPage,
});

function MemoryDocPage() {
  const { _splat } = Route.useParams();
  const path = _splat ?? "";
  const navigate = useNavigate();

  function onNavigateToChat() {
    void navigate({ to: "/chat" });
  }

  function onDeleted() {
    void navigate({ to: "/memory" });
  }

  /** A cross-reference inside the document opens the target in this pane —
   * the same splat route, so the tree/search pane stays mounted. */
  function onOpenPath(target: string) {
    void navigate({ to: "/memory/$", params: { _splat: target } });
  }

  return (
    <main className="flex-1 min-h-0 overflow-y-auto">
      <MemoryDoc
        path={path}
        onNavigateToChat={onNavigateToChat}
        onDeleted={onDeleted}
        onOpenPath={onOpenPath}
      />
    </main>
  );
}
