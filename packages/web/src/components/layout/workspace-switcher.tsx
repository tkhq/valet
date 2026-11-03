import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import type { TeamSummary } from "@valet/api/wire";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { Check, ChevronsUpDown, User, Users } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * Spaces: your own, and one per team you belong to. Desktop lists them in
 * the thread sidebar (`SpacesNav`) and names the active one in each scoped
 * page header (`WorkspaceClause`); the phone drawer keeps this dropdown.
 *
 * No space control carries an unread badge. Notifications stay global: the
 * bell polls every space, and each notification links to the conversation
 * that needs you, which switches space on arrival.
 *
 * A team with no assistant is still listed. It owns skills and workflows,
 * and hiding it would read as removal from the team.
 */
/**
 * The Presence or Workflows list to open after a workspace switch, or
 * `undefined` to stay. A detail page returns to its list. The Workflows
 * list reloads too, which drops its `run` and `gate` params.
 */
export function presenceListAfterSwitch(
  pathname: string,
): "/presence" | "/presence/activity" | "/workflows" | "/workflows/runs" | undefined {
  if (
    pathname.startsWith("/presence/places/")
    || pathname.startsWith("/presence/rules/")
    || pathname.startsWith("/presence/routines/")
  ) return "/presence";
  if (pathname.startsWith("/presence/events/")) return "/presence/activity";
  if (pathname === "/workflows" || (pathname.startsWith("/workflows/") && !pathname.startsWith("/workflows/runs"))) return "/workflows";
  if (pathname.startsWith("/workflows/runs/")) return "/workflows/runs";
  return undefined;
}

export interface WorkspaceOption {
  /** `user` for your own, else the team id. Stable across renders. */
  key: string;
  label: string;
  isTeam: boolean;

}

/**
 * The workspaces a caller can switch between, in rail order: yours first,
 * then teams as `GET /api/teams` returned them.
 *
 * A workspace with no assistant is still LISTED rather than hidden. Hiding
 * it would make a team you belong to silently absent from a control whose
 * whole job is to enumerate where you can work — the reader would conclude
 * they had been removed from the team.
 */
export function workspaceOptions(teams: TeamSummary[]): WorkspaceOption[] {
  return [
    { key: "user", label: "Personal", isTeam: false },
    ...teams.map(t => ({ key: t.id, label: t.name, isTeam: true })),
  ];
}

/** The caller's spaces: Personal, then each team they can open. */
export function useWorkspaceOptions(): WorkspaceOption[] {
  const teamsQ = useTeams();
  const orgQ = useOrg();
  return workspaceOptions(eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations));
}

/**
 * Switch the active space from anywhere: the Spaces sidebar, a page header's
 * space control, or the phone drawer. The URL is the source of truth, so a
 * switch names the new space in it (`?workspace=`); the scope provider then
 * stores it for the tab. A detail page returns to its list, so an old
 * resource is not requested under the new owner, and Chat opens the new
 * space's thread list.
 */
export function useSelectWorkspace(): (key: string) => void {
  const navigate = useNavigate();
  const scope = useWorkspaceScope();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return useCallback((key: string) => {
    if (key === scope.key) return;
    // Only navigate: the scope reads the new key from the URL and stores it.
    // A navigation that unsaved edits block therefore leaves the scope as is.
    const list = presenceListAfterSwitch(pathname);
    if (list) {
      // Drop old detail parameters and make the new workspace authoritative.
      void navigate({ to: list, search: { workspace: key } });
      return;
    }
    if (pathname === "/chat") {
      void navigate({ to: "/chat", search: { workspace: key, thread: undefined, child: undefined } });
      return;
    }
    // Every other page stays in place under the new name.
    void navigate({ to: ".", search: (prev) => ({ ...prev, workspace: key }) });
  }, [navigate, pathname, scope.key]);
}

export function WorkspaceSwitcher({
  options,
  activeKey,
  variant = "button",
  note,
  className,
}: {
  options: WorkspaceOption[];
  activeKey: string;
  /** `clause`: quiet text beside a page title (`WorkspaceClause`). */
  variant?: "button" | "clause";
  /** One line above the choices, such as who can see the active space. */
  note?: string;
  className?: string;
}) {
  const select = useSelectWorkspace();

  // One workspace is not a choice. A solo user sees the logo alone, exactly
  // as before teams existed.
  if (options.length < 2 && options.some(o => o.key === activeKey)) return null;

  const active = options.find((o) => o.key === activeKey) ?? { key: activeKey, label: "Unavailable workspace", isTeam: true };
  const label = `Space: ${active.label}. Change space`;
  const face = <>
    {active.isTeam ? <Users className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <User className="h-3.5 w-3.5 shrink-0" aria-hidden />}
    <span className="truncate text-sm">{active.label}</span>
    <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted" aria-hidden />
  </>;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "clause" ? (
          <button
            type="button"
            className={cn("inline-flex min-w-0 max-w-full items-center gap-1 rounded px-1 text-sm font-normal text-muted hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none", className)}
            aria-label={label}
          >
            {face}
          </button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("min-w-0 shrink gap-1.5 max-w-[11rem] md:shrink-0", className)}
            aria-label={label}
          >
            {face}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {note && <DropdownMenuLabel className="max-w-[16rem] text-xs font-normal text-muted">{note}</DropdownMenuLabel>}
        {options.map((o) => (
          <DropdownMenuItem key={o.key} onSelect={() => select(o.key)}>
            <span className={cn("flex w-full items-center gap-2", o.key === activeKey && "font-medium")}>
              {o.isTeam ? (
                <Users className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              ) : (
                <User className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              )}
              <span className="flex-1 truncate">{o.label}</span>
              {o.key === activeKey && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
