import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Brain, ChevronDown, ChevronRight, FileText, LayoutDashboard, MessageSquare, MoreHorizontal, Plug, Radio, ShieldCheck, Sparkles, User, Workflow, type LucideIcon } from "lucide-react";
import { pluginEnabledForCaller, useOrg } from "~/api/settings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "~/components/primitives";
import { useWorkspaceOptions, type WorkspaceOption } from "~/components/layout/workspace-options";
import { cn } from "~/lib/cn";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { CHROME_BUTTON, HOVER_CHROME, NESTED_IDLE, NESTED_ROW, SELECTED_ROW, SIDEBAR_LABEL, TOP_ROW } from "./sidebar-rows";

type SpacePage = {
  label: string;
  to: "/chat" | "/workflows" | "/presence" | "/artifacts" | "/overview" | "/memory" | "/skills" | "/integrations" | "/usage" | "/security";
  icon: LucideIcon;
};

/** The pages every space lists, in sidebar order. */
export const SPACE_PAGES: readonly SpacePage[] = [
  { label: "Threads", to: "/chat", icon: MessageSquare },
  { label: "Workflows", to: "/workflows", icon: Workflow },
  { label: "Presence", to: "/presence", icon: Radio },
  { label: "Artifacts", to: "/artifacts", icon: FileText },
];

/** A space's other pages, behind its More row. Security shows only when the caller has the plugin. */
export const SPACE_MORE_PAGES: readonly SpacePage[] = [
  { label: "Overview", to: "/overview", icon: LayoutDashboard },
  { label: "Memory", to: "/memory", icon: Brain },
  { label: "Skills", to: "/skills", icon: Sparkles },
  { label: "Integrations", to: "/integrations", icon: Plug },
  { label: "Usage", to: "/usage", icon: BarChart3 },
  { label: "Security", to: "/security", icon: ShieldCheck },
];

/** Pure: the space page a path belongs to. Home counts as Threads. */
export function spacePageFor(pathname: string): SpacePage["to"] | undefined {
  if (pathname === "/" || pathname === "/chat" || pathname.startsWith("/threads/")) return "/chat";
  return [...SPACE_PAGES, ...SPACE_MORE_PAGES].find((page) => page.to !== "/chat" && (pathname === page.to || pathname.startsWith(`${page.to}/`)))?.to;
}

function isMorePage(page: string | undefined): boolean {
  return SPACE_MORE_PAGES.some((candidate) => candidate.to === page);
}

/** The caller's More pages: Security only with the plugin. */
function useMorePages(): readonly SpacePage[] {
  const security = pluginEnabledForCaller(useOrg().data, "security") === true;
  return security ? SPACE_MORE_PAGES : SPACE_MORE_PAGES.filter((page) => page.to !== "/security");
}

const EXPANDED_KEY = "valet:spaces-expanded";
const MORE_EXPANDED_KEY = "valet:spaces-more-expanded";

function loadExpanded(key = EXPANDED_KEY): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
      : {};
  } catch {
    return {};
  }
}

function storeExpanded(value: Record<string, boolean>, key = EXPANDED_KEY): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
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
 * closed; this browser remembers each space's open state. Each open space
 * also has a More row for its other pages (Overview, Memory, Skills,
 * Integrations, Usage), closed until opened or until one of them is the
 * current page. A closed space shows all its pages in a menu on hover or
 * from its chevron. Its name opens the same page in that space, or its
 * Threads from Home and threads.
 */
export function SpacesNav() {
  const options = useWorkspaceOptions();
  const scope = useWorkspaceScope();
  const morePages = useMorePages();
  const page = spacePageFor(useRouterState({ select: (state) => state.location.pathname }));
  const [stored, setStored] = useState(() => loadExpanded());
  const isOpen = (key: string) => stored[key] ?? key === scope.key;
  const setOpen = (key: string, open: boolean) => {
    const next = { ...stored, [key]: open };
    setStored(next);
    storeExpanded(next);
  };
  const [moreStored, setMoreStored] = useState(() => loadExpanded(MORE_EXPANDED_KEY));
  const setMoreOpen = (key: string, open: boolean) => {
    setMoreStored((current) => {
      const next = { ...current, [key]: open };
      storeExpanded(next, MORE_EXPANDED_KEY);
      return next;
    });
  };
  // Arriving on one of a space's More pages opens its More, so the current
  // row shows. The person can close it again while they stay.
  const onMorePage = isMorePage(page);
  useEffect(() => {
    if (onMorePage && moreStored[scope.key] !== true) setMoreOpen(scope.key, true);
    // Runs on arrival only: a manual close while on the page must hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMorePage, page, scope.key]);
  const teamLabels = teamLabelsOf(options);
  // A space's name opens the page you are on in that space, so switching
  // keeps your place (Eng / Integrations to Sales / Integrations). From
  // Home, a thread, or a page no space owns, it opens the space's Threads.
  const nameTarget = page ?? "/chat";
  return <section aria-label="Spaces">
    <p className={SIDEBAR_LABEL}>Spaces</p>
    <ul className="space-y-0.5">
      {options.map((option) => <SpaceRow key={option.key} option={option} teamLabels={teamLabels} morePages={morePages} nameTarget={nameTarget}
        open={isOpen(option.key)} activePage={option.key === scope.key ? page : undefined} onOpenChange={(open) => setOpen(option.key, open)}
        moreOpen={moreStored[option.key] ?? (option.key === scope.key && onMorePage)} onMoreOpenChange={(open) => setMoreOpen(option.key, open)} />)}
    </ul>
  </section>;
}

function SpaceRow({ option, teamLabels, morePages, nameTarget, open, activePage, onOpenChange, moreOpen, onMoreOpenChange }: {
  option: WorkspaceOption; teamLabels: readonly string[]; morePages: readonly SpacePage[]; nameTarget: SpacePage["to"];
  open: boolean; activePage: string | undefined; onOpenChange: (open: boolean) => void;
  moreOpen: boolean; onMoreOpenChange: (open: boolean) => void;
}) {
  const pageRow = (page: SpacePage) => {
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
  };
  return <li>
    <div className={cn("group pr-1 hover:bg-ink-wash", TOP_ROW)}>
      <Link to={nameTarget} search={{ workspace: option.key }} onClick={() => onOpenChange(true)}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md pl-2 focus-visible:bg-ink-wash focus-visible:outline-none">
        <SpaceMark option={option} teamLabels={teamLabels} />
        <span className="truncate">{option.label}</span>
      </Link>
      {open
        ? <button type="button" aria-label={`Collapse ${option.label}`} aria-expanded onClick={() => onOpenChange(false)}
          className={cn(CHROME_BUTTON, HOVER_CHROME)}><ChevronDown aria-hidden className="h-3.5 w-3.5" /></button>
        : <SpacePagesMenu option={option} morePages={morePages}>
          <button type="button" aria-label={`Show ${option.label} pages`} aria-expanded={false}
            className={cn(CHROME_BUTTON, HOVER_CHROME)}><ChevronRight aria-hidden className="h-3.5 w-3.5" /></button>
        </SpacePagesMenu>}
    </div>
    {open && <ul aria-label={`${option.label} pages`} className="mt-0.5 space-y-0.5">
      {SPACE_PAGES.map(pageRow)}
      <li>
        <button type="button" aria-expanded={moreOpen} aria-label={`${moreOpen ? "Hide" : "Show"} more ${option.label} pages`} onClick={() => onMoreOpenChange(!moreOpen)}
          className={cn(NESTED_ROW, "group w-[calc(100%-1rem)] gap-2 pl-8 pr-1 text-left focus-visible:bg-ink-wash focus-visible:outline-none", NESTED_IDLE)}>
          <MoreHorizontal aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="flex-1">More</span>
          <ChevronRight aria-hidden className={cn("mr-1 h-3.5 w-3.5 text-muted transition-transform", HOVER_CHROME, moreOpen && "rotate-90")} />
        </button>
      </li>
      {moreOpen && <li><ul aria-label={`More ${option.label} pages`} className="space-y-0.5">{morePages.map(pageRow)}</ul></li>}
    </ul>}
  </li>;
}

/**
 * A space's pages as a small menu, opened on hover with a mouse or on click.
 * Closed space rows and the collapsed icon rail use it, so another space's
 * page is one click away.
 */
export function SpacePagesMenu({ option, morePages, children }: { option: WorkspaceOption; morePages: readonly SpacePage[]; children: ReactNode }) {
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
      {SPACE_PAGES.map((page) => <SpacePageItem key={page.to} option={option} page={page} />)}
      <DropdownMenuSeparator />
      {morePages.map((page) => <SpacePageItem key={page.to} option={option} page={page} />)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function SpacePageItem({ option, page }: { option: WorkspaceOption; page: SpacePage }) {
  return <DropdownMenuItem asChild>
    <Link to={page.to} search={{ workspace: option.key }}><page.icon aria-hidden className="h-4 w-4" />{page.label}</Link>
  </DropdownMenuItem>;
}

/**
 * The collapsed sidebar: a 44px rail of icons. Its first button expands the
 * sidebar again; then New thread, Home, and one icon per space whose pages
 * open in `SpacePagesMenu`.
 */
export function SpacesRail({ top }: { top: ReactNode }) {
  const options = useWorkspaceOptions();
  const scope = useWorkspaceScope();
  const morePages = useMorePages();
  const teamLabels = teamLabelsOf(options);
  return <nav aria-label="Sidebar" className="flex flex-col items-center gap-1 py-2">
    {top}
    <div className="my-1 h-px w-6 bg-line" aria-hidden />
    {options.map((option) => <SpacePagesMenu key={option.key} option={option} morePages={morePages}>
      <button type="button" aria-label={`${option.label} pages`}
        className={cn("flex h-8 w-8 items-center justify-center rounded-md hover:bg-ink-wash", option.key === scope.key ? "bg-ink-wash-strong text-ink" : "text-muted hover:text-ink")}>
        <SpaceMark option={option} teamLabels={teamLabels} />
      </button>
    </SpacePagesMenu>)}
  </nav>;
}
