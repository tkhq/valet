import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, User, Users } from "lucide-react";
import type { AssistantSummary, TeamSummary } from "@valet/api/wire";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * Which workspace you are working in: your own, or one of your teams.
 *
 * It sits beside the logo because it scopes the surfaces below it rather
 * than filtering one list — the same position Slack and Linear give a
 * workspace control, and the position that reads as "everything under here
 * belongs to this".
 *
 * **It has no unread badge, deliberately.** In a switcher the other
 * workspaces are off-screen by construction, so hiding attention behind it
 * would be the one real cost of this shape. Notifications stay global — the
 * bell already polls every workspace and every notification links straight
 * to the conversation that needs you, which switches context on arrival.
 * A badge here would be a second, weaker answer to a question the bell
 * already answers completely.
 */
export interface WorkspaceOption {
  /** `user` for your own, else the team id. Stable across renders. */
  key: string;
  label: string;
  isTeam: boolean;
  /** Where selecting it goes: that workspace's default assistant. Absent
   * when the workspace owns none, which makes the option unselectable. */
  defaultAssistantId?: string;
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
export function workspaceOptions(
  assistants: AssistantSummary[] | undefined,
  teams: TeamSummary[],
): WorkspaceOption[] {
  const defaultFor = (type: "user" | "team", id?: string): string | undefined =>
    (assistants ?? []).find(
      (a) => a.isDefault && a.owner.type === type && (id === undefined || a.owner.id === id),
    )?.id;

  return [
    { key: "user", label: "Personal", isTeam: false, defaultAssistantId: defaultFor("user") },
    ...teams.map((t) => ({
      key: t.id,
      label: t.name,
      isTeam: true,
      defaultAssistantId: defaultFor("team", t.id),
    })),
  ];
}

/**
 * The workspace the current assistant belongs to.
 *
 * Derived from the open assistant rather than held as its own state, so the
 * control cannot disagree with what is on screen. It also means a link into
 * another workspace — a notification, a shared URL, an owner badge — moves
 * the switcher on arrival instead of landing you in a conversation the
 * control claims you are not in.
 */
export function activeWorkspaceKey(active: AssistantSummary | undefined): string {
  if (!active) return "user";
  return active.owner.type === "team" ? active.owner.id : "user";
}

export function WorkspaceSwitcher({
  options,
  activeKey,
}: {
  options: WorkspaceOption[];
  activeKey: string;
}) {
  const navigate = useNavigate();

  // One workspace is not a choice. A solo user sees the logo alone, exactly
  // as before teams existed.
  if (options.length < 2) return null;

  const active = options.find((o) => o.key === activeKey) ?? options[0];
  if (!active) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5 max-w-[11rem]"
          aria-label={`Workspace: ${active.label}. Change workspace`}
        >
          {active.isTeam ? (
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate text-sm">{active.label}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.key}
            disabled={o.defaultAssistantId === undefined}
            onSelect={() => {
              if (!o.defaultAssistantId) return;
              // Switching navigates rather than setting state: the open
              // assistant is what defines the workspace, so moving the
              // conversation IS the switch, and there is no second copy of
              // the truth to fall out of step.
              void navigate({
                to: "/chat",
                search: { assistant: o.defaultAssistantId, thread: undefined, child: undefined },
              });
            }}
          >
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
