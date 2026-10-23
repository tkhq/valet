import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Badge, TabBar, tabPanelId } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { MakePanel } from "./make-panel";
import { TasksPanel, useNeedsYouCount } from "./tasks-panel";

export type MobileConversationView = "chat" | "tasks" | "make";
const LABEL = "Conversation";
const ToolbarTarget = createContext<HTMLElement | null>(null);

/** Place thread controls beside the shared conversation tabs. */
export function MobileConversationToolbar({ children }: { children: ReactNode }) {
  const target = useContext(ToolbarTarget);
  return target ? createPortal(children, target) : null;
}

/** The same phone navigation for Home and workspace threads. Chat stays
 * mounted while Tasks or Make shows, so switching views preserves drafts. */
export function MobileConversationLayout({ view, onViewChange, children }: {
  view: MobileConversationView;
  onViewChange: (view: MobileConversationView) => void;
  children: ReactNode;
}) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const needsYou = useNeedsYouCount();
  const showSide = view !== "chat";
  const tabs = [
    { id: "chat" as const, label: "Chat" },
    { id: "tasks" as const, label: "Tasks", badge: needsYou.count > 0
      ? <Badge variant="warning" className="px-1.5 py-0 text-[11px]">{needsYou.count}{needsYou.partial ? "+" : ""}</Badge> : undefined },
    { id: "make" as const, label: "Make" },
  ];
  return <div data-mobile-conversation className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center border-b border-line">
      <TabBar tabs={tabs} active={view} onSelect={onViewChange} label={LABEL} size="sm" className="min-w-0 flex-1 border-b-0 px-2" />
      <div ref={setToolbar} className={cn("shrink-0 pr-2", showSide && "hidden")} />
    </div>
    <ToolbarTarget.Provider value={toolbar}>
    <div id={tabPanelId(LABEL, "chat")} role="tabpanel" aria-hidden={showSide || undefined}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", showSide && "hidden")}>
      {children}
    </div>
    </ToolbarTarget.Provider>
    {showSide && <div id={tabPanelId(LABEL, view)} role="tabpanel"
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
      {view === "make" ? <MakePanel /> : <TasksPanel />}
    </div>}
  </div>;
}
