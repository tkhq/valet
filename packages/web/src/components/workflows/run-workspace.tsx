import { useId, type ReactNode } from "react";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { SessionView } from "~/components/session/session-view";

type Conversation = NonNullable<WorkflowRunDetail["conversations"]>[number];

/** Run conversations use the same transcript, composer, files and gates as chat. */
export function RunWorkspace({ conversations, view, conversationId, onSelect, children }: {
  conversations: Conversation[];
  view?: "conversation" | "details";
  conversationId?: string;
  onSelect: (view: "conversation" | "details", conversationId?: string) => void;
  children: ReactNode;
}) {
  const tabId = useId();
  const selected = conversations.find(item => item.threadId === conversationId) ?? conversations[0];
  const showChat = view !== "details" && !!selected;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 sm:px-6">
      <div role="tablist" aria-label="Automation run view" className="flex gap-4" onKeyDown={event => {
        if (!selected || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "conversation" : event.key === "End" ? "details" : showChat ? "details" : "conversation";
        onSelect(next, selected.threadId);
        event.currentTarget.querySelector<HTMLButtonElement>(`[id="${tabId}-${next}"]`)?.focus();
      }}>
        <button type="button" role="tab" id={`${tabId}-conversation`} aria-controls={`${tabId}-conversation-panel`} tabIndex={showChat ? 0 : -1} aria-selected={showChat} disabled={!selected}
          className={`min-h-11 border-b-2 text-sm disabled:opacity-50 ${showChat ? "border-moss text-ink" : "border-transparent text-muted"}`}
          onClick={() => onSelect("conversation", selected?.threadId)}>Conversation</button>
        <button type="button" role="tab" id={`${tabId}-details`} aria-controls={`${tabId}-details-panel`} tabIndex={!showChat ? 0 : -1} aria-selected={!showChat}
          className={`min-h-11 border-b-2 text-sm ${!showChat ? "border-moss text-ink" : "border-transparent text-muted"}`}
          onClick={() => onSelect("details", selected?.threadId)}>Run details</button>
      </div>
      {showChat && conversations.length > 1 && <select aria-label="Run conversation"
        className="my-1 min-h-10 min-w-0 max-w-full rounded border border-line bg-paper px-2 text-sm text-ink sm:ml-auto"
        value={selected?.threadId} onChange={event => onSelect("conversation", event.target.value)}>
        {conversations.map((item, index) => <option key={`${item.sessionId}:${item.threadId}`} value={item.threadId}>
          {item.title || item.nodeId || `Conversation ${index + 1}`}
        </option>)}
      </select>}
    </div>
    {selected && <div role="tabpanel" id={`${tabId}-conversation-panel`} aria-labelledby={`${tabId}-conversation`} hidden={!showChat}
      className={showChat ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <p className="shrink-0 border-b border-line px-4 py-2 text-xs text-muted">Replies continue this conversation; they do not restart the workflow.</p>
      <SessionView key={`${selected.sessionId}:${selected.threadId}`} sessionId={selected.sessionId}
        activeThreadId={selected.threadId} active={showChat} enableReplies />
    </div>}
    <div role="tabpanel" id={`${tabId}-details-panel`} aria-labelledby={`${tabId}-details`} hidden={showChat} className={!showChat ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {children}
    </div>
  </div>;
}
