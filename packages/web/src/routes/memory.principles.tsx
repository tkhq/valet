import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MemoryPrinciplesPanel } from "~/components/memory/memory-principles";

/**
 * `/memory/principles` — the rules agents follow. A static segment, like
 * `/memory/usage`, so the router ranks it above the `/memory/$` doc splat.
 */
export const Route = createFileRoute("/memory/principles")({
  component: MemoryPrinciplesPage,
});

function MemoryPrinciplesPage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <MemoryPrinciplesPanel onSelect={(path) => void navigate({ to: "/memory/$", params: { _splat: path } })} />
    </div>
  );
}
