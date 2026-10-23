import { Badge, Button, ErrorRow, LoadingRow, TabBar, tabPanelId } from "~/components/primitives";
import { SessionView } from "~/components/session/session-view";
import { useHomeConversation } from "~/api/home";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { HomeEmptyState } from "./home-empty-state";
import { MakePanel } from "./make-panel";
import { NeedsYouDock } from "./needs-you-dock";
import { TasksPanel, useNeedsYouCount } from "./tasks-panel";

export type HomeView = "chat" | "tasks" | "make";

const TABS_LABEL = "Home";

/**
 * The phone's first screen: the person's one ongoing conversation with Valet,
 * with Tasks (what is in flight) and Make (what Valet made, its workflows,
 * skills and memory) behind a Chat/Tasks/Make switch under the top bar. The
 * conversation stays mounted while another tab shows, so a draft or a
 * running turn is not lost. A wider screen shows the web dashboard instead.
 */
export function HomeScreen({ view, onViewChange }: { view: HomeView; onViewChange: (view: HomeView) => void }) {
  const home = useHomeConversation();
  const needsYou = useNeedsYouCount();
  const showSide = view !== "chat";
  if (home.isError) return <div className="m-auto max-w-sm space-y-3 p-6 text-center">
    <ErrorRow>Could not open your conversation with Valet. {errorText(home.error)}</ErrorRow>
    <Button variant="secondary" onClick={() => void home.refetch()}>Retry</Button>
  </div>;
  if (!home.data) return <div className="flex flex-1 items-center justify-center"><LoadingRow label="Opening Valet…" /></div>;
  const tabs = [
    { id: "chat" as const, label: "Chat" },
    { id: "tasks" as const, label: "Tasks",
      badge: needsYou.count > 0 ? <Badge variant="warning" className="px-1.5 py-0 text-[11px]">{needsYou.count}{needsYou.partial ? "+" : ""}</Badge> : undefined },
    { id: "make" as const, label: "Make" },
  ];
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <TabBar tabs={tabs} active={view} onSelect={onViewChange} label={TABS_LABEL} size="sm" className="shrink-0 px-2" />
    {/* A class, not the hidden attribute: `flex` would override the attribute. */}
    <div id={tabPanelId(TABS_LABEL, "chat")} role="tabpanel" aria-hidden={showSide || undefined}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", showSide && "hidden")}>
      <SessionView sessionId={home.data.sessionId} activeThreadId={home.data.threadId} panel hidePanelHeader chatOnly enableReplies
        active={!showSide}
        composerAccessory={<NeedsYouDock homeThreadId={home.data.threadId} onOpenTasks={() => onViewChange("tasks")} />}
        emptyState={<HomeEmptyState sessionId={home.data.sessionId} threadId={home.data.threadId} />} />
    </div>
    {showSide && <div id={tabPanelId(TABS_LABEL, view)} role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
      {view === "make" ? <MakePanel /> : <TasksPanel />}
    </div>}
  </div>;
}
