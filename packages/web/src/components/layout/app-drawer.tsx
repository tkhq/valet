import { useEffect, useRef } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { House } from "lucide-react";
import { Badge } from "~/components/primitives";
import { useNeedsYouCount } from "~/components/home/tasks-panel";
import { AssistantRail } from "~/components/session/assistant-rail";
import { cn } from "~/lib/cn";
import { useSidebarControls } from "./app-shell";

const ROW = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm max-md:min-h-11 hover:bg-ink-wash focus-visible:bg-ink-wash focus-visible:outline-none";

/**
 * The one navigation surface for conversations: Home, the Spaces tree with
 * each space's pages, and the open space's threads. Valet's other pages live under Home's
 * Make tab, and Settings under the avatar (`AccountMenu`). It is the left
 * column on desktop and a full-screen drawer on a phone (`AppShell`), on
 * every page.
 */
export function AppDrawer() {
  const onHome = useRouterState({ select: (st) => st.location.pathname === "/" });
  const needsYou = useNeedsYouCount();
  // A navigation closes the phone drawer, including one from a thread's
  // menu, which renders outside the drawer. Only a change counts: the
  // drawer's own copy mounts when it opens and must not close itself.
  const href = useRouterState({ select: (st) => st.location.href });
  const closeDrawer = useSidebarControls()?.closeDrawer;
  const shownHref = useRef(href);
  useEffect(() => {
    if (shownHref.current === href) return;
    shownHref.current = href;
    closeDrawer?.();
  }, [href, closeDrawer]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 space-y-1 px-2 pt-2">
      <Link to="/" className={cn(ROW, onHome ? "bg-moss-wash-strong font-medium text-ink" : "text-ink/85")}>
        <House className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1">Home</span>
        {needsYou.count > 0 && <Badge variant="warning" aria-label={`${needsYou.count} need you`}>{needsYou.count}{needsYou.partial ? "+" : ""}</Badge>}
      </Link>
    </div>
    <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
      <AssistantRail />
    </div>
  </div>;
}
