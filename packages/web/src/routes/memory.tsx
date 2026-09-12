import { ArrowLeft } from "lucide-react";
import { Link, Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { MemoryImportExport } from "~/components/memory/import-export";
import { WorkspaceClause } from "~/components/workspace-clause";
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
    <div className="flex flex-1 min-h-0 min-w-0 flex-col md:flex-row">
      <aside className={cn(
        "flex min-h-0 min-w-0 flex-col border-b border-line md:h-auto md:w-72 md:shrink-0 md:border-b-0 md:border-r",
        activePath || isGraph ? "shrink-0" : "flex-1 md:flex-none",
      )}>
        <div className="flex items-center gap-1 px-2 pt-2">
          <ViewTab to="/memory" label="Files" active={!isGraph} back={Boolean(activePath) || isGraph} />
          <ViewTab to="/memory/graph" label="Graph" active={isGraph} />
          <span className="ml-auto pr-1">
            <WorkspaceClause />
          </span>
        </div>
        <div className={cn("flex-1 min-h-0 overflow-y-auto", (activePath || isGraph) && "hidden md:block")}>
          <MemorySearchPane activePath={activePath} onSelect={onSelect} />
        </div>
        <div className={cn((activePath || isGraph) && "hidden md:block")}>
          <MemoryImportExport />
        </div>
      </aside>
      <Outlet />
    </div>
  );
}

function ViewTab({ to, label, active, back }: { to: string; label: string; active: boolean; back?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex min-h-11 items-center rounded px-2.5 py-1 text-sm md:min-h-0 md:text-xs font-medium transition-colors",
        active ? "bg-moss-wash text-moss" : "text-muted hover:bg-ink-wash hover:text-ink",
      )}
    >
      {back && <ArrowLeft className="mr-1 h-3.5 w-3.5 md:hidden" aria-hidden />}
      {label}
    </Link>
  );
}
