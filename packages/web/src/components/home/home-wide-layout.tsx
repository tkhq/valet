import type { ReactNode } from "react";
import { Badge, TabBar, tabPanelId } from "~/components/primitives";
import { MakePanel } from "./make-panel";
import { TasksPanel, useNeedsYouCount } from "./tasks-panel";

export type HomeSideView = "tasks" | "make";
const LABEL = "Home panel";

/** Home on a wider screen: the conversation fills the page and Tasks or Make
 * stays open beside it. It is the phone's Chat, Tasks, and Make flow with the
 * conversation always in view. */
export function HomeWideLayout({ side, onSideChange, children }: {
  side: HomeSideView;
  onSideChange: (side: HomeSideView) => void;
  children: ReactNode;
}) {
  const needsYou = useNeedsYouCount();
  const tabs = [
    { id: "tasks" as const, label: "Tasks", badge: needsYou.count > 0
      ? <Badge variant="warning" className="px-1.5 py-0 text-[11px]">{needsYou.count}{needsYou.partial ? "+" : ""}</Badge> : undefined },
    { id: "make" as const, label: "Make" },
  ];
  return <div data-home-wide className="flex min-h-0 min-w-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    <aside aria-label="Tasks and Make" className="flex min-h-0 w-[clamp(18rem,32vw,26rem)] shrink-0 flex-col border-l border-line">
      <TabBar tabs={tabs} active={side} onSelect={onSideChange} label={LABEL} size="sm" className="shrink-0 px-2" />
      <div id={tabPanelId(LABEL, side)} role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">
        {side === "make" ? <MakePanel /> : <TasksPanel />}
      </div>
    </aside>
  </div>;
}
