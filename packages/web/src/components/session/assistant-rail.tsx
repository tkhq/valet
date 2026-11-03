import { Link, useRouterState } from "@tanstack/react-router";
import { House, PanelLeftOpen } from "lucide-react";
import type { TeamSummary } from "@valet/api/wire";
import { useSidebarControls } from "~/components/layout/app-shell";
import { useCurrentWorkspace, useWorkspaceConversation } from "~/hooks/use-workspace-conversation";
import { cn } from "~/lib/cn";
import { SpacesRail } from "./spaces-nav";
import { ThreadTree, ThreadTreeWaiting } from "./thread-tree";

/** The app-wide sidebar: New thread, Home, Spaces, and on thread pages the
 * open space's Projects and threads. Child work polls only there. */
export function AssistantRail() {
  const conversation = useWorkspaceConversation();
  const workspace = useCurrentWorkspace();
  const onThreads = useRouterState({ select: (state) => state.location.pathname === "/" || state.location.pathname === "/chat" });
  if (conversation.error) return <div role="alert" className="p-4 text-sm text-danger-500">
    Could not load threads. <button className="underline" onClick={() => void conversation.refetch()}>Retry</button>
  </div>;
  return <>
    {conversation.data ? <ThreadTree sessionId={conversation.data.sessionId} workspace={workspace} showChildren={onThreads} /> : <ThreadTreeWaiting />}
  </>;
}

const RAIL_BUTTON = "flex h-8 w-8 items-center justify-center rounded hover:bg-ink-wash";

/** The collapsed sidebar: expand, Home, and each space's pages from its icon. */
export function AssistantRailCollapsed() {
  const controls = useSidebarControls();
  const onHome = useRouterState({ select: (state) => state.location.pathname === "/" });
  return <SpacesRail top={<>
    <button type="button" aria-label="Expand sidebar" title="Expand sidebar" onClick={controls?.toggleCollapsed} className={cn(RAIL_BUTTON, "text-muted hover:text-ink")}>
      <PanelLeftOpen aria-hidden className="h-4 w-4" />
    </button>
    <Link to="/" aria-label="Home" title="Home" className={cn(RAIL_BUTTON, onHome ? "bg-ink-wash-strong text-ink" : "text-muted hover:text-ink")}>
      <House aria-hidden className="h-4 w-4" />
    </Link>
  </>} />;
}

/** Teams whose assistants the caller may open: the org feature gate is on,
 * and they are a member. An org admin sees every team in the org from
 * `GET /api/teams`, so membership alone is not the test — `callerRole` is
 * null for a team they only administer. */
export function eligibleTeams(
  teams: TeamSummary[] | undefined,
  organizationsEnabled: boolean | undefined,
): TeamSummary[] {
  if (organizationsEnabled !== true) return [];
  return (teams ?? []).filter((t) => t.callerRole !== null);
}
