/**
 * The Routines tab (docs/specs/2026-10-16-presence-hub-design.md Part D): the
 * active workspace's routines, each as one sentence. A row opens the
 * routine's page, fires the routine now, and carries a problem badge when
 * the scheduler turned the routine off.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import { usePinnedThreadTitles } from "~/api/rule";
import { useRunScheduleNow, useWorkflowTriggers, useWorkflows } from "~/api/workflows";
import { Button, EmptyRow, ErrorRow, LoadingRow, WorkRow, WorkSection } from "~/components/primitives";
import { retryPhrase } from "~/components/events/delivery-copy";
import { TriggerDialog } from "~/components/workflows/trigger-dialog";
import { errorText } from "~/lib/error-text";
import { useListOwner } from "~/lib/use-list-owner";
import { ProblemBadge } from "./problem-badge";
import { routineSentence } from "./sentences";

/** A schedule row of the triggers list: what the Routines tab lists. */
export type Routine = Extract<WorkflowTriggerItem, { kind: "schedule" }>;

export function isRoutine(item: WorkflowTriggerItem): item is Routine {
  return item.kind === "schedule";
}

/** The sentence for each routine. It reads the workflow names and the
 * titles of pinned threads. */
export function useRoutineSentence(routines: readonly Routine[]): (routine: Routine) => string {
  const workflows = useWorkflows();
  const pinned = usePinnedThreadTitles(routines.map((r) => r.detail.thread));
  const names = workflows.data?.workflows ?? [];
  return (routine) => routineSentence(routine, names, pinned);
}

/** When the routine fires next, or that it is off. */
export function routineWhen(routine: Routine, now: number = Date.now()): string {
  if (!routine.enabled) return "Off";
  const wait = routine.detail.nextFireAt - now;
  return wait <= 0 ? "Due now" : `Fires next ${retryPhrase(wait)}`;
}

export function RoutinesTab() {
  const owner = useListOwner();
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled: owner !== undefined });
  const routines = (triggersQ.data?.triggers ?? []).filter(isRoutine);
  const sentence = useRoutineSentence(routines);
  const fire = useRunScheduleNow();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function fireNow(routine: Routine) {
    setMessage(null);
    fire.mutate(routine.id, {
      onSuccess: () => setMessage({ text: `Fired ${routine.name}. It runs now.`, error: false }),
      onError: (err) => setMessage({ text: errorText(err), error: true }),
    });
  }

  return (
    <div className="space-y-3">
      <WorkSection
        title="Routines"
        count={triggersQ.isSuccess ? routines.length : undefined}
        actions={(
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            New routine
          </Button>
        )}
      >
        {(owner === undefined || triggersQ.isPending) && <LoadingRow className="px-4" />}
        {triggersQ.isError && (
          <ErrorRow className="px-4">{errorText(triggersQ.error, "Could not load the routines. Reload the page to try again.")}</ErrorRow>
        )}
        {triggersQ.isSuccess && routines.length === 0 && (
          <EmptyRow className="px-4 py-3">No routine yet. Select New routine to have Valet act at a set time.</EmptyRow>
        )}
        {routines.map((routine) => (
          <WorkRow
            key={routine.id}
            title={<Link to="/presence/routines" search={{ routine: routine.id }}>{sentence(routine)}</Link>}
            // The second line already says Off for a routine that is off.
            badge={<ProblemBadge problem={routine.detail.disabledReason} />}
            detail={routineWhen(routine)}
            actions={(
              <Button size="sm" variant="ghost" disabled={fire.isPending} onClick={() => fireNow(routine)} aria-label={`Fire ${routine.name} now`}>
                Fire now
              </Button>
            )}
          />
        ))}
      </WorkSection>
      {message && (
        <p role={message.error ? "alert" : "status"} className={message.error ? "text-sm text-danger-500" : "text-sm text-muted"}>
          {message.text}
        </p>
      )}
      {creating && <TriggerDialog open onOpenChange={setCreating} schedulesOnly />}
    </div>
  );
}
