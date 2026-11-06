import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MemoryUsagePanel } from "~/components/memory/memory-usage";

/**
 * `/memory/usage` — which files agents use, which they never use, and a
 * trim for stale files. A static segment, like `/memory/graph`, so the
 * router ranks it above the `/memory/$` doc splat. The parent layout keeps
 * the tree pane; this route owns the right pane.
 */
export const Route = createFileRoute("/memory/usage")({
  component: MemoryUsagePage,
});

function MemoryUsagePage() {
  const navigate = useNavigate();
  return (
    // A plain `div`, not `main`: the app shell already renders the page's one
    // `main` landmark, and this route paints inside it.
    <div className="flex flex-1 min-h-0 flex-col">
      <MemoryUsagePanel onSelect={(path) => void navigate({ to: "/memory/$", params: { _splat: path } })} />
    </div>
  );
}
