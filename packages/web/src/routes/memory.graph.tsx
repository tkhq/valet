import { createFileRoute } from "@tanstack/react-router";
import { MemoryGraphCanvas } from "~/components/memory/memory-graph";

/**
 * `/memory/graph` — the explorer's graph view (V1 parity). A static
 * segment, so the router ranks it above the `/memory/$` doc splat. The
 * tree/search pane stays mounted via the parent layout; this route owns
 * the right pane only.
 */
export const Route = createFileRoute("/memory/graph")({
  component: MemoryGraphPage,
});

function MemoryGraphPage() {
  return (
    // A plain `div`, not `main`: the app shell already renders the page's one
    // `main` landmark, and this route paints inside it.
    <div className="flex flex-1 min-h-0 flex-col">
      <MemoryGraphCanvas />
    </div>
  );
}
