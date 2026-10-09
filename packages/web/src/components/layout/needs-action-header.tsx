import { useRef, useState } from "react";
import type { ListNotificationDecisionsResponse, WorkflowActionRequiredItem } from "@valet/api/wire";
import { useResolveDecisions } from "~/api/queries";
import { useMe } from "~/api/settings";
import { useResolveWorkflowApprovals } from "~/api/workflows";
import { Badge, Button, ConfirmDialog } from "~/components/primitives";
import {
  answerAll, decisionRequest, planBulkAnswers, reconcileBulkAnswers, SKIP_REASON_TEXT, summarizeBulkAnswers, workflowRequest,
  type BulkDecision, type BulkTarget, type SkippedItem,
} from "./bulk-answers";

const VERB: Record<BulkDecision, { label: string; ing: string }> = {
  approve: { label: "Approve", ing: "Approving" },
  deny: { label: "Deny", ing: "Denying" },
};

function requests(n: number) {
  return n === 1 ? "request" : "requests";
}

export interface BulkAnswerRun {
  progress: { decision: BulkDecision; settled: number; total: number } | null;
  summary: string;
  start: (decision: BulkDecision, targets: readonly BulkTarget[]) => Promise<void>;
  /** Clears a settled summary. A run in flight keeps its progress. */
  dismiss: () => void;
}

/** Run state for bulk answers. `NotificationsBell` owns it, not the popover
 * content: closing the bell unmounts the content, and a run must keep its
 * progress and summary, and block a second run, until it settles.
 * `refresh` refetches the lists and returns the keys still listed, or
 * undefined when the refetch failed. A target still listed is not answered. */
export function useBulkAnswerRun(refresh: () => Promise<ReadonlySet<string> | undefined>): BulkAnswerRun {
  const resolveDecision = useResolveDecisions();
  const resolveWorkflow = useResolveWorkflowApprovals();
  const [progress, setProgress] = useState<BulkAnswerRun["progress"]>(null);
  const [summary, setSummary] = useState("");
  /** True from confirm until the last answer settles. A ref, so a second
   * click before the next render cannot start a second run. */
  const inFlight = useRef(false);

  function answer(target: BulkTarget, decision: BulkDecision) {
    return target.kind === "decision"
      ? resolveDecision.mutateAsync({ sessionId: target.sessionId, gateId: target.gateId, body: decisionRequest(decision) })
      : resolveWorkflow.mutateAsync({ runId: target.runId, nodeId: target.nodeId, body: workflowRequest(target, decision) });
  }

  async function start(decision: BulkDecision, targets: readonly BulkTarget[]) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSummary("");
    setProgress({ decision, settled: 0, total: targets.length });
    const outcome = await answerAll(targets, target => answer(target, decision),
      settled => setProgress({ decision, settled, total: targets.length }));
    const listed = await refresh().catch(() => undefined);
    inFlight.current = false;
    setProgress(null);
    setSummary(summarizeBulkAnswers(decision, reconcileBulkAnswers(outcome, listed)));
  }

  return { progress, summary, start, dismiss: () => { if (!inFlight.current) setSummary(""); } };
}

/** What the confirm does, in the dialog's description. A tool action runs
 * once; a workflow approval node lets its run go on to its next steps. */
function describe(decision: BulkDecision, targets: readonly BulkTarget[], partial: boolean): string {
  const parts = [decision === "approve" ? "Valet approves each request below." : "Valet denies each request below."];
  if (decision === "approve") {
    if (targets.some(t => t.kind === "decision" || t.policy)) parts.push("Each tool action runs once. Valet saves no rule and allows no later calls.");
    if (targets.some(t => t.kind === "workflow" && !t.policy)) parts.push("Each workflow approval lets its run continue to the next steps.");
  }
  if (partial) parts.push("This covers only the requests listed in the bell. Other pages are not included.");
  return parts.join(" ");
}

/** The bell's "Needs action" heading with "Approve all" and "Deny all". A
 * bulk answer covers only the items listed now (`partial` when the bell
 * shows one page of several), and the dialog names each one before it runs. */
export function NeedsActionHeader({ pendingCount, partialCount, workflows, decisions, partial, run }: {
  pendingCount: number;
  /** The first decision page is not the whole inbox: the badge shows "+". */
  partialCount: boolean;
  workflows: readonly WorkflowActionRequiredItem[];
  decisions: ListNotificationDecisionsResponse["items"];
  /** The bell lists one decision page of several, so a bulk answer covers
   * only the listed items. */
  partial: boolean;
  run: BulkAnswerRun;
}) {
  const me = useMe();
  const [pending, setPending] = useState<{ decision: BulkDecision; targets: BulkTarget[]; skipped: SkippedItem[] } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  /** Set on confirm: the dialog then hands focus to the status line. */
  const started = useRef(false);
  /** The button that opened the dialog. Cancel returns focus to it. */
  const openedBy = useRef<HTMLButtonElement | null>(null);
  const live = planBulkAnswers(workflows, decisions, me.data?.id);
  const { progress, summary } = run;

  function startConfirmedRun() {
    if (!pending) return;
    started.current = true;
    setPending(null);
    void run.start(pending.decision, pending.targets);
  }

  const running = progress !== null;
  const n = live.targets.length;
  const message = progress
    ? `${VERB[progress.decision].ing} ${Math.min(progress.settled + 1, progress.total)} of ${progress.total}…`
    : summary;
  const verb = pending ? VERB[pending.decision] : VERB.approve;
  const description = pending ? describe(pending.decision, pending.targets, partial) : "";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Needs action</h3>
        <Badge variant={pendingCount ? "warning" : "neutral"}>{pendingCount}{partialCount ? "+" : ""}</Badge>
        {(n > 0 || running) && <div className="ml-auto flex gap-2">
          {(["approve", "deny"] as const).map(decision => {
            const label = partial ? `${VERB[decision].label} ${n} listed` : `${VERB[decision].label} all`;
            return (
              <Button key={decision} size="sm" variant="secondary" disabled={running || n === 0}
                aria-label={partial ? `${label} ${requests(n)}` : `${label} ${n} ${requests(n)}`}
                onClick={event => { started.current = false; openedBy.current = event.currentTarget; setPending({ decision, ...live }); }}>
                {label}
              </Button>
            );
          })}
        </div>}
      </div>
      <p ref={status} role="status" tabIndex={-1} className={message ? "text-sm text-muted outline-none" : "sr-only"}>{message}</p>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={open => { if (!open) setPending(null); }}
        title={`${verb.label} ${pending?.targets.length ?? 0} ${requests(pending?.targets.length ?? 0)}?`}
        description={description}
        confirmLabel={`${verb.label} ${pending?.targets.length ?? 0}`}
        onConfirm={startConfirmedRun}
        confirmVariant={pending?.decision === "approve" ? "primary" : "danger"}
        onCloseAutoFocus={event => {
          // After a confirmed run, focus the progress line: the buttons are
          // disabled, and they leave the page when no item is left. After
          // Cancel, focus the button that opened the dialog. Radix's own
          // restore lands on the body inside the bell's popover.
          event.preventDefault();
          const back = openedBy.current;
          if (!started.current && back?.isConnected) back.focus();
          else status.current?.focus();
        }}
      >
        {pending && <div className="space-y-3 text-sm">
          <ul aria-label={`Requests to ${verb.label.toLowerCase()}`} className="max-h-48 space-y-1 overflow-y-auto">
            {pending.targets.map(t => <li key={t.key} className="break-words">
              <span>{t.title}</span>{t.context && <span className="block text-xs text-muted">{t.context}</span>}
            </li>)}
          </ul>
          {pending.skipped.length > 0 && <div>
            <p className="text-xs font-semibold text-muted">Not included</p>
            <ul aria-label="Not included" className="max-h-32 space-y-1 overflow-y-auto text-muted">
              {pending.skipped.map(s => <li key={s.key} className="break-words">{s.title}: {SKIP_REASON_TEXT[s.reason]}</li>)}
            </ul>
          </div>}
        </div>}
      </ConfirmDialog>
    </div>
  );
}
