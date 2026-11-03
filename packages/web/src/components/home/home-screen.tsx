import { useEffect, useState, type ReactNode } from "react";
import { ListChecks, X } from "lucide-react";
import { Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { SessionView } from "~/components/session/session-view";
import { useHomeConversation } from "~/api/home";
import { errorText } from "~/lib/error-text";
import { queueBusy, useQueueStateForThread } from "~/stores/stream";
import { HomeEmptyState, greeting } from "./home-empty-state";
import { MobileConversationLayout, type MobileConversationView } from "./mobile-conversation-layout";
import { NeedsYouDock } from "./needs-you-dock";
import { TasksPanel, useNeedsYouCount } from "./tasks-panel";
import { loadTasksPanelChoice, storeTasksPanelChoice } from "./tasks-panel-choice";
export type HomeView = MobileConversationView;

/**
 * Valet's first screen: the person's one ongoing conversation with Valet,
 * with Tasks (what is in flight) and Make (what Valet made, its workflows,
 * skills and memory). On a phone they sit behind a Chat/Tasks/Make switch
 * under the top bar, and the conversation stays mounted while another tab
 * shows, so a draft or a running turn is not lost. A wider screen (`wide`)
 * shows Home inside the Threads layout: see `HomeDesktop`.
 */
export function HomeScreen({ view, onViewChange, wide = false }: { view: HomeView; onViewChange: (view: HomeView) => void; wide?: boolean }) {
  const home = useHomeConversation();
  const [answering, setAnswering] = useState(false);
  const showSide = !wide && view !== "chat";
  if (home.isError) return <div className="m-auto max-w-sm space-y-3 p-6 text-center">
    <ErrorRow>Could not open your conversation with Valet. {errorText(home.error)}</ErrorRow>
    <Button variant="secondary" onClick={() => void home.refetch()}>Retry</Button>
  </div>;
  if (!home.data) return <div className="flex flex-1 items-center justify-center"><LoadingRow label="Opening Valet…" /></div>;
  const dock = <NeedsYouDock homeThreadId={home.data.threadId} onQuestionExpandedChange={setAnswering} onOpenTasks={() => onViewChange("tasks")} />;
  const empty = <HomeEmptyState sessionId={home.data.sessionId} threadId={home.data.threadId} />;
  if (wide) return <HomeDesktop sessionId={home.data.sessionId} threadId={home.data.threadId} dock={dock} empty={empty}
    tasksRequested={view === "tasks"} onTasksClosed={() => { if (view === "tasks") onViewChange("chat"); }} />;
  return <MobileConversationLayout view={view} onViewChange={onViewChange}>
    <SessionView sessionId={home.data.sessionId} activeThreadId={home.data.threadId} panel hidePanelHeader chatOnly sharedConversationChrome enableReplies
      active={!showSide}
      suppressComposer={answering}
      composerAccessory={dock}
      emptyState={empty} />
  </MobileConversationLayout>;
}

/**
 * Desktop Home, in the main pane of the Threads layout. While Home is idle it
 * shows the greeting and starters over the transcript; typing, a starter, or a running
 * turn gives way to the conversation. The header's Tasks button opens a
 * collapsible status panel beside it. The panel is open by default; the
 * person's last choice for this browser wins once they toggle it.
 * `?view=tasks` and the approvals dock open it without storing a choice.
 */
function HomeDesktop({ sessionId, threadId, dock, empty, tasksRequested, onTasksClosed }: {
  sessionId: string; threadId: string; dock: ReactNode; empty: ReactNode;
  tasksRequested: boolean; onTasksClosed: () => void;
}) {
  const [landing, setLanding] = useState(true);
  const busy = queueBusy(useQueueStateForThread(sessionId, threadId));
  useEffect(() => { if (busy) setLanding(false); }, [busy]);
  const needsYou = useNeedsYouCount();
  const [tasksOpen, setTasksOpen] = useState(() => tasksRequested || (loadTasksPanelChoice() ?? true));
  useEffect(() => { if (tasksRequested) setTasksOpen(true); }, [tasksRequested]);
  const chooseTasksOpen = (open: boolean) => {
    setTasksOpen(open);
    storeTasksPanelChoice(open);
    if (!open) onTasksClosed();
  };
  const count = needsYou.count > 0 ? ` · ${needsYou.count}${needsYou.partial ? "+" : ""}` : "";
  const tasksButton = <Button size="sm" variant={tasksOpen ? "secondary" : "ghost"} aria-pressed={tasksOpen} onClick={() => chooseTasksOpen(!tasksOpen)}>
    <ListChecks aria-hidden className="h-4 w-4" />{`Tasks${count}`}
  </Button>;
  return <div data-home-desktop className="flex min-h-0 min-w-0 flex-1" onInput={() => setLanding(false)}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionView sessionId={sessionId} activeThreadId={threadId} chatOnly enableReplies composerAccessory={dock} emptyState={empty}
        headerActions={tasksButton}
        cover={landing ? <HomeEmptyState sessionId={sessionId} threadId={threadId} title={greeting(new Date())} onPick={() => setLanding(false)}>
          <p className="flex gap-4 text-sm text-muted">
            <button type="button" className="hover:text-ink hover:underline" onClick={() => setLanding(false)}>Show conversation</button>
          </p>
        </HomeEmptyState> : undefined} />
    </div>
    {tasksOpen && <aside aria-label="Tasks" className="flex min-h-0 w-[clamp(18rem,30vw,24rem)] shrink-0 flex-col border-l border-line">
      {/* Same height, padding and title type as the thread header beside it, so the two bottom borders form one line. */}
      <div className="flex h-[--nav-height] shrink-0 items-center justify-between border-b border-line pl-4 pr-2">
        <h2 className="font-display text-sm font-semibold tracking-tight text-ink">Tasks</h2>
        <Button size="sm" variant="ghost" aria-label="Close tasks" onClick={() => chooseTasksOpen(false)}><X aria-hidden className="h-4 w-4" /></Button>
      </div>
      <TasksPanel className="min-h-0 flex-1 overflow-y-auto p-4" />
    </aside>}
  </div>;
}
