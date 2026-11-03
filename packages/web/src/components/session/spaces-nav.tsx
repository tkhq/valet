import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, FileText, MessageSquare, Radio, User, Users, Workflow, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "~/components/primitives";
import { useWorkspaceOptions, type WorkspaceOption } from "~/components/layout/workspace-options";
import { cn } from "~/lib/cn";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/** The pages every space has, in sidebar order. */
export const SPACE_PAGES: ReadonlyArray<{ label: string; to: "/chat" | "/workflows" | "/presence" | "/artifacts"; icon: LucideIcon }> = [
  { label: "Threads", to: "/chat", icon: MessageSquare },
  { label: "Workflows", to: "/workflows", icon: Workflow },
  { label: "Presence", to: "/presence", icon: Radio },
  { label: "Artifacts", to: "/artifacts", icon: FileText },
];

/** Pure: the space page a path belongs to. Home counts as Threads. */
export function spacePageFor(pathname: string): (typeof SPACE_PAGES)[number]["to"] | undefined {
  if (pathname === "/" || pathname === "/chat" || pathname.startsWith("/threads/")) return "/chat";
  return SPACE_PAGES.find((page) => page.to !== "/chat" && (pathname === page.to || pathname.startsWith(`${page.to}/`)))?.to;
}

const EXPANDED_KEY = "valet:spaces-expanded";

function loadExpanded(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
      : {};
  } catch {
    return {};
  }
}

function storeExpanded(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(value));
  } catch {
    // Without storage the active space opens and the others close on reload.
  }
}

/**
 * The sidebar's Spaces, Linear style: Personal, then each team. An open space
 * lists its pages (Threads, Workflows, Presence, Artifacts); each row opens
 * that page with `?workspace=` naming the space, so the URL stays the one
 * source of truth for scope. The active space starts open and the others
 * closed; this browser remembers each space's open state. A closed space
 * shows its pages in a menu on hover or from its chevron, and its name opens
 * the space and its Threads.
 */
export function SpacesNav() {
  const options = useWorkspaceOptions();
  const scope = useWorkspaceScope();
  const page = spacePageFor(useRouterState({ select: (state) => state.location.pathname }));
  const [stored, setStored] = useState(loadExpanded);
  const isOpen = (key: string) => stored[key] ?? key === scope.key;
  const setOpen = (key: string, open: boolean) => {
    const next = { ...stored, [key]: open };
    setStored(next);
    storeExpanded(next);
  };
  return <section aria-label="Spaces" className="pt-2">
    <p className="px-4 pb-1 text-xs font-medium text-muted">Spaces</p>
    <ul>
      {options.map((option) => <SpaceRow key={option.key} option={option} active={option.key === scope.key}
        open={isOpen(option.key)} activePage={option.key === scope.key ? page : undefined} onOpenChange={(open) => setOpen(option.key, open)} />)}
    </ul>
  </section>;
}

function SpaceRow({ option, active, open, activePage, onOpenChange }: {
  option: WorkspaceOption; active: boolean; open: boolean;
  activePage: string | undefined; onOpenChange: (open: boolean) => void;
}) {
  const Icon = option.isTeam ? Users : User;
  return <li>
    <div className="flex items-center pr-2">
      <Link to="/chat" search={{ workspace: option.key }} onClick={() => onOpenChange(true)}
        className={cn("flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-4 text-sm focus-visible:bg-ink-wash focus-visible:outline-none",
          active ? "font-medium text-ink" : "text-ink/85 hover:text-ink")}>
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="truncate">{option.label}</span>
      </Link>
      {open
        ? <button type="button" aria-label={`Collapse ${option.label}`} aria-expanded onClick={() => onOpenChange(false)}
          className="rounded p-1 text-muted hover:bg-ink-wash hover:text-ink"><ChevronDown aria-hidden className="h-3.5 w-3.5" /></button>
        : <SpacePagesMenu option={option}>
          <button type="button" aria-label={`Show ${option.label} pages`} aria-expanded={false}
            className="rounded p-1 text-muted hover:bg-ink-wash hover:text-ink"><ChevronDown aria-hidden className="h-3.5 w-3.5 -rotate-90" /></button>
        </SpacePagesMenu>}
    </div>
    {open && <ul aria-label={`${option.label} pages`}>
      {SPACE_PAGES.map((page) => {
        const current = page.to === activePage;
        return <li key={page.to}>
          <Link to={page.to} search={{ workspace: option.key }} aria-current={current ? "page" : undefined}
            className={cn("flex items-center gap-2 border-l-2 py-1.5 pr-3 pl-[calc(2.25rem-2px)] text-sm focus-visible:bg-ink-wash focus-visible:outline-none",
              current ? "border-moss bg-moss-wash-strong font-medium text-ink" : "border-transparent text-ink/85 hover:bg-ink-wash/60")}>
            <page.icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
            {page.label}
          </Link>
        </li>;
      })}
    </ul>}
  </li>;
}

/**
 * A space's pages as a small menu, opened on hover with a mouse or on click.
 * Closed space rows and the collapsed icon rail use it, so another space's
 * page is one click away.
 */
export function SpacePagesMenu({ option, children }: { option: WorkspaceOption; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const leave = () => { closeTimer.current = setTimeout(() => setMenuOpen(false), 150); };
  return <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
    {/* Hover opens it, and a click keeps it open: the trigger's own pointer
        toggle would close a menu that hover just opened. */}
    <DropdownMenuTrigger asChild onPointerEnter={(event) => {
      if (event.pointerType !== "mouse") return;
      cancelClose(); setMenuOpen(true);
    }} onPointerLeave={leave}
    onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
    onClick={() => { cancelClose(); setMenuOpen(true); }}>{children}</DropdownMenuTrigger>
    <DropdownMenuContent side="right" align="start" className="w-44" onPointerEnter={cancelClose} onPointerLeave={leave}>
      <DropdownMenuLabel className="text-xs font-normal text-muted">{option.label}</DropdownMenuLabel>
      {SPACE_PAGES.map((page) => <DropdownMenuItem key={page.to} asChild>
        <Link to={page.to} search={{ workspace: option.key }}><page.icon aria-hidden className="h-4 w-4" />{page.label}</Link>
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/**
 * The collapsed sidebar: a 44px rail of icons. Its first button expands the
 * sidebar again; then New thread, Home, and one icon per space whose pages
 * open in `SpacePagesMenu`.
 */
export function SpacesRail({ top }: { top: ReactNode }) {
  const options = useWorkspaceOptions();
  const scope = useWorkspaceScope();
  return <nav aria-label="Sidebar" className="flex flex-col items-center gap-1 py-2">
    {top}
    <div className="my-1 h-px w-6 bg-line" aria-hidden />
    {options.map((option) => {
      const Icon = option.isTeam ? Users : User;
      return <SpacePagesMenu key={option.key} option={option}>
        <button type="button" aria-label={`${option.label} pages`}
          className={cn("flex h-8 w-8 items-center justify-center rounded hover:bg-ink-wash", option.key === scope.key ? "bg-moss-wash-strong text-ink" : "text-muted hover:text-ink")}>
          <Icon aria-hidden className="h-4 w-4" />
        </button>
      </SpacePagesMenu>;
    })}
  </nav>;
}
