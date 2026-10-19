import { useId, type ReactNode } from "react";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { Select, TabBar, tabPanelId } from "~/components/primitives";
import { SessionView } from "~/components/session/session-view";

type Conversation = NonNullable<WorkflowRunDetail["conversations"]>[number];

/** Run conversations use the same transcript, composer, files and gates as chat. */
export function RunWorkspace({ conversations, view, conversationId, onSelect, back, children }: {
  conversations: Conversation[];
  view?: "conversation" | "details";
  conversationId?: string;
  onSelect: (view: "conversation" | "details", conversationId?: string) => void;
  /** The link back to the workflow, shown in the tab bar so it stays on
   *  screen on the conversation tab too. */
  back?: ReactNode;
  children: ReactNode;
}) {
  const tabId = useId();
  // A run with no conversation has only details: no tab bar to choose from.
  if (conversations.length === 0) return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
  const selected = conversations.find(item => item.threadId === conversationId) ?? conversations[0];
  const showChat = view !== "details" && !!selected;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 sm:px-6">
      {back && <div className="mr-2 min-w-0 max-w-full">{back}</div>}
      <TabBar label="Automation run view" id={tabId} className="shadow-none" active={showChat ? "conversation" : "details"}
        onSelect={next => onSelect(next, selected?.threadId)}
        tabs={[{ id: "conversation", label: "Conversation", disabled: !selected }, { id: "details", label: "Run details" }]} />
      {showChat && conversations.length > 1 && <Select aria-label="Run conversation"
        className="my-1 min-w-0 max-w-full sm:ml-auto"
        value={selected?.threadId} onChange={event => onSelect("conversation", event.target.value)}>
        {conversations.map((item, index) => <option key={`${item.sessionId}:${item.threadId}`} value={item.threadId}>
          {item.title || item.nodeId || `Conversation ${index + 1}`}
        </option>)}
      </Select>}
    </div>
    {selected && <div role="tabpanel" id={tabPanelId(tabId, "conversation")} aria-labelledby={`${tabPanelId(tabId, "conversation")}-tab`} hidden={!showChat}
      className={showChat ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <p className="shrink-0 border-b border-line px-4 py-2 text-xs text-muted">Replies continue this conversation; they do not restart the workflow.</p>
      <SessionView key={`${selected.sessionId}:${selected.threadId}`} sessionId={selected.sessionId}
        activeThreadId={selected.threadId} active={showChat} enableReplies />
    </div>}
    <div role="tabpanel" id={tabPanelId(tabId, "details")} aria-labelledby={`${tabPanelId(tabId, "details")}-tab`} hidden={showChat} className={!showChat ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {children}
    </div>
  </div>;
}
