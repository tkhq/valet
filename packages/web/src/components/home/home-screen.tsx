import { useState } from "react";
import { Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { SessionView } from "~/components/session/session-view";
import { useHomeConversation } from "~/api/home";
import { errorText } from "~/lib/error-text";
import { HomeEmptyState } from "./home-empty-state";
import { MobileConversationLayout, type MobileConversationView } from "./mobile-conversation-layout";
import { NeedsYouDock } from "./needs-you-dock";
export type HomeView = MobileConversationView;

/**
 * The phone's first screen: the person's one ongoing conversation with Valet,
 * with Tasks (what is in flight) and Make (what Valet made, its workflows,
 * skills and memory) behind a Chat/Tasks/Make switch under the top bar. The
 * conversation stays mounted while another tab shows, so a draft or a
 * running turn is not lost. A wider screen shows the web dashboard instead.
 */
export function HomeScreen({ view, onViewChange }: { view: HomeView; onViewChange: (view: HomeView) => void }) {
  const home = useHomeConversation();
  const [answering, setAnswering] = useState(false);
  const showSide = view !== "chat";
  if (home.isError) return <div className="m-auto max-w-sm space-y-3 p-6 text-center">
    <ErrorRow>Could not open your conversation with Valet. {errorText(home.error)}</ErrorRow>
    <Button variant="secondary" onClick={() => void home.refetch()}>Retry</Button>
  </div>;
  if (!home.data) return <div className="flex flex-1 items-center justify-center"><LoadingRow label="Opening Valet…" /></div>;
  return <MobileConversationLayout view={view} onViewChange={onViewChange}>
    <SessionView sessionId={home.data.sessionId} activeThreadId={home.data.threadId} panel hidePanelHeader chatOnly sharedConversationChrome enableReplies
      active={!showSide}
      suppressComposer={answering}
      composerAccessory={<NeedsYouDock homeThreadId={home.data.threadId} onQuestionExpandedChange={setAnswering} onOpenTasks={() => onViewChange("tasks")} />}
      emptyState={<HomeEmptyState sessionId={home.data.sessionId} threadId={home.data.threadId} />} />
  </MobileConversationLayout>;
}
