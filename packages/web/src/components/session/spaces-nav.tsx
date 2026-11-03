import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, FileText, MessageSquare, Radio, User, Workflow, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "~/components/primitives";
import { useWorkspaceOptions, type WorkspaceOption } from "~/components/layout/workspace-options";
import { cn } from "~/lib/cn";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { CHROME_BUTTON, HOVER_CHROME, NESTED_IDLE, NESTED_ROW, SELECTED_ROW, SIDEBAR_LABEL, TOP_ROW } from "./sidebar-rows";

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

/** Muted tints for team marks. Static strings, so Tailwind emits each one. */
const SPACE_TINTS = [
  "bg-[oklch(70%_0.10_30/0.22)] text-[oklch(45%_0.12_30)] dark:text-[oklch(82%_0.09_30)]",
  "bg-[oklch(75%_0.10_75/0.25)] text-[oklch(45%_0.10_75)] dark:text-[oklch(85%_0.09_75)]",
  "bg-[oklch(70%_0.10_150/0.22)] text-[oklch(42%_0.10_150)] dark:text-[oklch(82%_0.09_150)]",
  "bg-[oklch(70%_0.08_210/0.22)] text-[oklch(42%_0.09_210)] dark:text-[oklch(82%_0.08_210)]",
  "bg-[oklch(68%_0.10_270/0.22)] text-[oklch(45%_0.13_270)] dark:text-[oklch(82%_0.09_270)]",
  "bg-[oklch(70%_0.10_330/0.22)] text-[oklch(45%_0.12_330)] dark:text-[oklch(82%_0.09_330)]",
] as const;

/** Pure: a team's tint, stable for its id. */
export function spaceTint(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SPACE_TINTS[hash % SPACE_TINTS.length] ?? SPACE_TINTS[0];
}

/**
 * Pure: the letter on a team's mark. Words that every team name starts with
 * (a company name) are skipped, so "Acme Platform" and "Acme Design" read
 * P and D, not A and A.
 */
export function spaceInitial(label: string, teamLabels: readonly string[]): string {
  const words = (name: string) => name.trim().split(/\s+/).filter(Boolean);
  const own = words(label);
  let skip = 0;
  if (teamLabels.length > 1) {
    const all = teamLabels.map(words);
    while (skip < own.length - 1 && all.every((other) => other.length > skip + 1 && other[skip]?.toLowerCase() === own[skip]?.toLowerCase())) skip += 1;
  }
  return (own[skip]?.[0] ?? "?").toUpperCase();
}

/** A space's 16px mark: the person icon for Personal, a tinted initial for a team. */
export function SpaceMark({ option, teamLabels }: { option: WorkspaceOption; teamLabels: readonly string[] }) {
  if (!option.isTeam) return <User aria-hidden className="h-4 w-4 shrink-0 text-muted" />;
  return <span aria-hidden data-space-mark className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold leading-none", spaceTint(option.key))}>
    {spaceInitial(option.label, teamLabels)}
  </span>;
}

function teamLabelsOf(options: readonly WorkspaceOption[]): string[] {
  return options.filter((option) => option.isTeam).map((option) => option.label);
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
  const teamLabels = teamLabelsOf(options);
  return <section aria-label="Spaces">
    <p className={SIDEBAR_LABEL}>Spaces</p>
    <ul className="space-y-0.5">
      {options.map((option) => <SpaceRow key={option.key} option={option} teamLabels={teamLabels}
        open={isOpen(option.key)} activePage={option.key === scope.key ? page : undefined} onOpenChange={(open) => setOpen(option.key, open)} />)}
    </ul>
  </section>;
}

function SpaceRow({ option, teamLabels, open, activePage, onOpenChange }: {
  option: WorkspaceOption; teamLabels: readonly string[]; open: boolean;
  activePage: string | undefined; onOpenChange: (open: boolean) => void;
}) {
  return <li>
    <div className={cn("group pr-1 hover:bg-ink-wash", TOP_ROW)}>
      <Link to="/chat" search={{ workspace: option.key }} onClick={() => onOpenChange(true)}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md pl-2 focus-visible:bg-ink-wash focus-visible:outline-none">
        <SpaceMark option={option} teamLabels={teamLabels} />
        <span className="truncate">{option.label}</span>
      </Link>
      {open
        ? <button type="button" aria-label={`Collapse ${option.label}`} aria-expanded onClick={() => onOpenChange(false)}
          className={cn(CHROME_BUTTON, HOVER_CHROME)}><ChevronDown aria-hidden className="h-3.5 w-3.5" /></button>
        : <SpacePagesMenu option={option}>
          <button type="button" aria-label={`Show ${option.label} pages`} aria-expanded={false}
            className={cn(CHROME_BUTTON, HOVER_CHROME)}><ChevronRight aria-hidden className="h-3.5 w-3.5" /></button>
        </SpacePagesMenu>}
    </div>
    {open && <ul aria-label={`${option.label} pages`} className="mt-0.5 space-y-0.5">
      {SPACE_PAGES.map((page) => {
        const current = page.to === activePage;
        // On Threads the open thread (or Home) holds the selected fill, so
        // its page shows as current with primary text only: one highlighted
        // row at a time.
        const filled = current && page.to !== "/chat";
        return <li key={page.to}>
          <Link to={page.to} search={{ workspace: option.key }} aria-current={current ? "page" : undefined}
            className={cn(NESTED_ROW, "gap-2 pl-8 pr-2 focus-visible:bg-ink-wash focus-visible:outline-none",
              filled ? SELECTED_ROW : current ? "text-ink hover:bg-ink-wash" : NESTED_IDLE)}>
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
  const teamLabels = teamLabelsOf(options);
  return <nav aria-label="Sidebar" className="flex flex-col items-center gap-1 py-2">
    {top}
    <div className="my-1 h-px w-6 bg-line" aria-hidden />
    {options.map((option) => <SpacePagesMenu key={option.key} option={option}>
      <button type="button" aria-label={`${option.label} pages`}
        className={cn("flex h-8 w-8 items-center justify-center rounded-md hover:bg-ink-wash", option.key === scope.key ? "bg-ink-wash-strong text-ink" : "text-muted hover:text-ink")}>
        <SpaceMark option={option} teamLabels={teamLabels} />
      </button>
    </SpacePagesMenu>)}
  </nav>;
}
