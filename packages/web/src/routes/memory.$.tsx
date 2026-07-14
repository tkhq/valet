import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MemorySearchPane } from "~/components/memory/memory-search";
import { MemoryDoc } from "~/components/memory/memory-doc";

/**
 * `/memory/$` — the explorer's document view. The splat param (`_splat`,
 * TanStack Router's key for a `$`-suffixed catch-all file — see
 * `router-core`'s `path.js`) is the file path, which legitimately contains
 * slashes (`journal/2026-07-13.md`); a plain `$path` param would only
 * capture a single segment, which is why this is a splat route rather than
 * `?path=` (the brief's fallback for when splat routing turns out to be
 * awkward — it wasn't).
 */
export const Route = createFileRoute("/memory/$")({
  component: MemoryDocPage,
});

function MemoryDocPage() {
  const { _splat } = Route.useParams();
  const path = _splat ?? "";
  const navigate = useNavigate();

  function onSelect(nextPath: string) {
    void navigate({ to: "/memory/$", params: { _splat: nextPath } });
  }

  function onNavigateToChat() {
    void navigate({ to: "/chat" });
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col md:flex-row">
      <aside className="h-64 shrink-0 border-b border-line overflow-y-auto md:h-auto md:w-72 md:border-b-0 md:border-r">
        <MemorySearchPane activePath={path} onSelect={onSelect} />
      </aside>
      <main className="flex-1 min-h-0 overflow-y-auto">
        <MemoryDoc path={path} onNavigateToChat={onNavigateToChat} />
      </main>
    </div>
  );
}
