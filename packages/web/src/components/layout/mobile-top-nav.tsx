import { Link } from "@tanstack/react-router";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { AccountMenu } from "./account-menu";
import { useSidebarControls } from "./app-shell";

const ICON_BUTTON =
  "inline-flex shrink-0 min-h-8 min-w-8 max-md:min-h-11 max-md:min-w-11 items-center justify-center rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none";

/**
 * The drawer control, at the bar's left edge. Two buttons, not one, because
 * they do different things and must say so: on a phone the drawer opens over
 * the page, while on desktop the column collapses in place.
 */
function DrawerToggle() {
  const controls = useSidebarControls();
  if (controls === null || !controls.present) return null;
  return <>
    <button type="button" aria-label="Open menu" onClick={controls.openDrawer} className={`md:hidden ${ICON_BUTTON}`}>
      <Menu className="h-5 w-5" aria-hidden />
    </button>
    <button type="button" aria-label={controls.collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!controls.collapsed}
      onClick={controls.toggleCollapsed} className={`hidden md:inline-flex ${ICON_BUTTON}`}>
      {controls.collapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden /> : <PanelLeftClose className="h-4 w-4" aria-hidden />}
    </button>
  </>;
}

/**
 * The phone top bar: the drawer control, the mark that returns Home, and the
 * person's avatar, which opens Settings (`AccountMenu`). Threads live in the
 * drawer (`AppDrawer`) and the rest of Valet's pages under Home's Make tab,
 * so a phone shows three controls, not a row of links. A wider screen keeps
 * the web top bar (`TopNav`).
 */
export function MobileTopNav() {
  return (
    <header className="max-sm:[--nav-height:3rem] h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center gap-1 px-2 md:gap-3 md:px-3">
      <DrawerToggle />
      <Link to="/" className="inline-flex min-h-8 items-center gap-2 rounded px-1.5 py-1 hover:bg-ink-wash max-md:min-h-11" aria-label="Valet home">
        <span className="text-moss text-base leading-none" aria-hidden>◈</span>
        <span className="font-display text-sm font-medium text-ink">Valet</span>
      </Link>
      <AccountMenu />
    </header>
  );
}
