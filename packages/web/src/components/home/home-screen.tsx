import { useState } from "react";
import { Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { SessionView } from "~/components/session/session-view";
import { useHomeConversation } from "~/api/home";
import { errorText } from "~/lib/error-text";
import { HomeEmptyState } from "./home-empty-state";
import { HomeWideLayout } from "./home-wide-layout";
import { MobileConversationLayout, type MobileConversationView } from "./mobile-conversation-layout";
import { NeedsYouDock } from "./needs-you-dock";
export type HomeView = MobileConversationView;

/**
 * Valet's first screen: the person's one ongoing conversation with Valet,
 * with Tasks (what is in flight) and Make (what Valet made, its workflows,
 * skills and memory). On a phone they sit behind a Chat/Tasks/Make switch
 * under the top bar, and the conversation stays mounted while another tab
 * shows, so a draft or a running turn is not lost. A wider screen (`wide`)
 * keeps the conversation in view and shows Tasks or Make beside it.
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
  if (wide) {
    // The full thread header keeps the desktop model picker and thread menu.
    return <HomeWideLayout side={view === "make" ? "make" : "tasks"}
      onSideChange={(side) => onViewChange(side === "make" ? "make" : "chat")}>
      <SessionView sessionId={home.data.sessionId} activeThreadId={home.data.threadId} chatOnly enableReplies
        composerAccessory={dock} emptyState={empty} />
    </HomeWideLayout>;
  }
  return <MobileConversationLayout view={view} onViewChange={onViewChange}>
    <SessionView sessionId={home.data.sessionId} activeThreadId={home.data.threadId} panel hidePanelHeader chatOnly sharedConversationChrome enableReplies
      active={!showSide}
      suppressComposer={answering}
      composerAccessory={dock}
      emptyState={empty} />
  </MobileConversationLayout>;
}
