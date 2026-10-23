import { useEffect, useState } from "react";
import { useNotificationDecisions } from "~/api/queries";
import { useWorkflowActionRequired } from "~/api/workflows";
import { cn } from "~/lib/cn";
import { Button } from "~/components/primitives";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { ResolvedGateNotice, useResolvedGateNotice } from "~/components/session/gate-outcome";

/**
 * Approvals from work in any workspace, docked above the home composer so
 * the person can answer without leaving home. It shows one card at a time
 * with "1 of 3", and folds to one line on "Not now". The home thread's own
 * gate docks through `SessionView`, so it is left out here.
 */
export function NeedsYouDock({ homeThreadId, onOpenTasks, onQuestionExpandedChange }: { homeThreadId?: string; onOpenTasks: () => void; onQuestionExpandedChange?: (expanded: boolean) => void }) {
  const decisions = useNotificationDecisions();
  const workflows = useWorkflowActionRequired();
  const items = (decisions.data?.items ?? []).filter(item => item.gate.threadId !== homeThreadId);
  const workflowCount = workflows.data?.count ?? 0;
  const [index, setIndex] = useState(0);
  const [folded, setFolded] = useState(false);
  const total = items.length;
  // A new approval unfolds the dock; an answered one moves to the next.
  const newest = items[0]?.gate.id;
  useEffect(() => { setFolded(false); }, [newest]);
  useEffect(() => { if (index >= total) setIndex(Math.max(0, total - 1)); }, [index, total]);
  const current = items[Math.min(index, total - 1)];
  const resolved = useResolvedGateNotice(current?.gate);
  const expanded = !folded && current?.gate.type === "question";
  useEffect(() => { onQuestionExpandedChange?.(expanded); }, [expanded, onQuestionExpandedChange]);
  useEffect(() => () => onQuestionExpandedChange?.(false), [onQuestionExpandedChange]);
  if (total === 0 && workflowCount === 0) return resolved ? <ResolvedGateNotice label={resolved.label} title={resolved.gate.title} className="border-t border-line" /> : null;
  const label = total > 0 ? `${current?.gate.type === "question" ? "Question" : "Approval"} ${Math.min(index, total - 1) + 1} of ${total}` : "";
  const waiting = total + workflowCount;
  const summary = <div className="flex items-center gap-2 border-t border-line px-4 py-1.5 text-xs text-muted">
      <span className="min-w-0 flex-1 truncate">{waiting} {waiting === 1 ? "request is" : "requests are"} waiting</span>
      {current && <Button size="sm" variant="ghost" onClick={() => setFolded(false)}>Show</Button>}
      <Button size="sm" variant="ghost" onClick={onOpenTasks}>All in Tasks</Button>
    </div>;
  if (!current) return summary;
  return <>
  {folded && summary}
  <section aria-label="Approvals from your work" aria-hidden={folded || undefined} className={cn("min-h-0 shrink overflow-y-auto overscroll-contain border-t border-line max-md:max-h-[min(70dvh,calc(var(--app-viewport-height,100dvh)-8rem))] max-md:pb-[env(safe-area-inset-bottom)]", folded && "hidden")}>
    {resolved && <ResolvedGateNotice label={resolved.label} title={resolved.gate.title} />}
    <div className="flex items-center gap-2 px-4 pt-2 text-xs text-muted">
      <span className="min-w-0 flex-1 truncate">{label} · {current.title}</span>
      {total > 1 && <Button size="sm" variant="ghost" onClick={() => setIndex((index + 1) % total)}>Next</Button>}
      <Button size="sm" variant="ghost" onClick={() => setFolded(true)}>Not now</Button>
    </div>
    <DecisionGateCard key={current.gate.id} sessionId={current.sessionId} gate={current.gate} placement="notification" mobileScroll />
  </section>
  </>;
}
