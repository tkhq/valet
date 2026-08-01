import { Link, Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { MemoryImportExport } from "~/components/memory/import-export";
import { MemorySearchPane } from "~/components/memory/memory-search";
import { cn } from "~/lib/cn";

/**
 * `/memory` — the explorer's layout shell (Task 6 brief, decision 17):
 * tree in the left pane, routed content (index hint or doc) in the right
 * pane via `<Outlet/>`. No app sidebar for memory routes — this pane below
 * IS the left pane (see `__root.tsx`'s `sidebarForPath`, which special-cases
 * `/memory` and `/memory/*` to render no `<aside>` at all; the explorer owns
 * its full two-pane layout inside `<main>`).
 *
 * This is a layout route with two children: `memory.index.tsx` (the resting
 * "select a file" state, at `/memory`) and `memory.$.tsx` (the doc view, at
 * `/memory/$splat`). Search/tree lives here so both children share it
 * instead of duplicating it; the active row is derived from the current
 * pathname rather than from child route params, since a layout route has no
 * access to its child's params.
 */
export const Route = createFileRoute("/memory")({
  component: MemoryLayout,
});

const MEMORY_PREFIX = "/memory/";

function MemoryLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isGraph = pathname === "/memory/graph";
  const activePath =
    !isGraph && pathname.startsWith(MEMORY_PREFIX)
      ? decodeURIComponent(pathname.slice(MEMORY_PREFIX.length))
      : undefined;

  function onSelect(path: string) {
    void navigate({ to: "/memory/$", params: { _splat: path } });
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col md:flex-row">
      <aside className="flex h-64 shrink-0 flex-col border-b border-line md:h-auto md:w-72 md:border-b-0 md:border-r">
        <div className="flex items-center gap-1 px-2 pt-2">
          <ViewTab to="/memory" label="Files" active={!isGraph} />
          <ViewTab to="/memory/graph" label="Graph" active={isGraph} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <MemorySearchPane activePath={activePath} onSelect={onSelect} />
        </div>
        <MemoryImportExport />
      </aside>
      <Outlet />
    </div>
  );
}

function ViewTab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        "rounded px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-moss-wash text-moss" : "text-muted hover:bg-ink-wash hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
}
