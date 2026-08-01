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
    <main className="flex flex-1 min-h-0 flex-col">
      <MemoryGraphCanvas />
    </main>
  );
}
