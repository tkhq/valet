/**
 * The Routines pane (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 1): the active workspace's routines, each as one sentence with
 * `Next: <time>` or `Off`, an on/off switch, and Fire now. A row opens the
 * routine's page and carries a problem badge when the scheduler turned the
 * routine off.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import { usePinnedThreadTitles } from "~/api/rule";
import { useRunScheduleNow, useUpdateSchedule, useWorkflowTriggers, useWorkflows } from "~/api/workflows";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { Button, EmptyRow, ErrorRow, LoadingRow, Switch, WorkRow, WorkSection } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { useListOwner } from "~/lib/use-list-owner";
import { ProblemBadge } from "./problem-badge";
import { routineSentence } from "./sentences";

/** A schedule row of the triggers list: what the Routines pane lists. */
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

/** When the routine fires next (spec Part E step 1: `Next: <time>`), or that it is off. */
export function routineWhen(routine: Routine, now: number = Date.now()): string {
  if (!routine.enabled) return "Off";
  const next = routine.detail.nextFireAt;
  return next - now <= 0 ? "Due now" : `Next: ${new Date(next).toLocaleString()}`;
}

export function RoutinesPane() {
  const owner = useListOwner();
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled: owner !== undefined });
  const routines = (triggersQ.data?.triggers ?? []).filter(isRoutine);
  const sentence = useRoutineSentence(routines);
  const fire = useRunScheduleNow();
  const update = useUpdateSchedule();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function fireNow(routine: Routine) {
    setMessage(null);
    fire.mutate(routine.id, {
      onSuccess: () => setMessage({ text: `Fired ${routine.name}. It runs now.`, error: false }),
      onError: (err) => setMessage({ text: errorText(err), error: true }),
    });
  }

  function setEnabled(routine: Routine, enabled: boolean) {
    setMessage(null);
    update.mutate({ id: routine.id, body: { enabled } }, {
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
              <>
                <Switch
                  checked={routine.enabled}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) => setEnabled(routine, enabled)}
                  aria-label={`${routine.enabled ? "Turn off" : "Turn on"} ${routine.name}`}
                />
                <Button size="sm" variant="ghost" disabled={fire.isPending} onClick={() => fireNow(routine)} aria-label={`Fire ${routine.name} now`}>
                  Fire now
                </Button>
              </>
            )}
          />
        ))}
      </WorkSection>
      {message && (
        <p role={message.error ? "alert" : "status"} className={message.error ? "text-sm text-danger-500" : "text-sm text-muted"}>
          {message.text}
        </p>
      )}
      {creating && <AutomationWizard open onOpenChange={setCreating} startOn="routine" />}
    </div>
  );
}
