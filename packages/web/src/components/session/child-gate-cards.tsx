import type { ChildWorkSummary } from "@valet/api/wire";
import { useChildGates } from "~/api/child-work";
import { DecisionGateCard } from "./decision-gate-card";

/**
 * A running child's open approvals, shown in the thread that started it and
 * labeled with the child's title. Each card answers against the child
 * session, so the same people may answer it as in the child's own thread.
 */
export function ChildGateCards({ children, threadId, onOpenChild }: {
  children: readonly ChildWorkSummary[];
  threadId: string | undefined;
  onOpenChild?: (childSessionId: string) => void;
}) {
  const gates = useChildGates(children, threadId);
  return gates.map(({ child, gate }) => (
    <section key={`${child.sessionId}:${gate.id}`} aria-label={`Request from ${child.title}`}>
      <p className="mx-auto mt-3 w-full min-w-0 max-w-[52rem] truncate px-5 text-xs text-muted sm:px-8">
        From{" "}
        {onOpenChild
          ? <button type="button" className="font-medium text-ink hover:underline" onClick={() => onOpenChild(child.sessionId)}>{child.title}</button>
          : <span className="font-medium text-ink">{child.title}</span>}
      </p>
      <DecisionGateCard sessionId={child.sessionId} gate={gate} />
    </section>
  ));
}
