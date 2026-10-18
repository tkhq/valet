/**
 * What every routine surface shares: the `Routine` type, the sentence and
 * `<do>` hooks, `Next: <time>` or `Off`, and the Fire now and on/off
 * actions (docs/specs/2026-10-16-presence-hub-design.md Part E). The
 * overview's `On a schedule` rows, the routine page, and the workflow
 * triggers drawer read them.
 */
import { useState } from "react";
import type { UpdateWorkflowScheduleRequest, WorkflowTriggerItem } from "@valet/api/wire";
import { usePinnedThreadTitles } from "~/api/rule";
import { useRunScheduleNow, useUpdateSchedule, useWorkflows } from "~/api/workflows";
import { errorText } from "~/lib/error-text";
import { formatDateTime } from "~/lib/format-when";
import { routineDoes, routineSentence } from "./sentences";

/** A schedule row of the triggers list. */
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

/** The `<do>` of each routine. It reads the workflow names and the titles of pinned threads. */
export function useRoutineDoes(routines: readonly Routine[]): (routine: Routine) => string {
  const workflows = useWorkflows();
  const pinned = usePinnedThreadTitles(routines.map((r) => r.detail.thread));
  const names = workflows.data?.workflows ?? [];
  return (routine) => routineDoes(routine, names, pinned);
}

/**
 * When the routine fires next, or that it is off: `Next<separator><date and
 * time>`, `Due now`, or `Off`. The time has no seconds and reads in the
 * schedule's timezone, so it agrees with the zone the row shows. The overview
 * row uses `" "` (spec Part B step 6); the routine page and the Workflows
 * drawer use `": "` (Part E step 1). `locale` pins the reader's locale in
 * tests.
 */
export function routineWhen(
  routine: Pick<Routine, "enabled" | "detail">,
  separator: " " | ": ",
  now: number = Date.now(),
  locale?: string,
): string {
  if (!routine.enabled) return "Off";
  const next = routine.detail.nextFireAt;
  if (next - now <= 0) return "Due now";
  const timeZone = routine.detail.timezone.trim();
  return `Next${separator}${formatDateTime(next, { locale, ...(timeZone !== "" ? { timeZone } : {}) })}`;
}

/** A row's message: the result of Fire now, or a refusal. */
export interface RoutineMessage {
  text: string;
  error: boolean;
}

/**
 * Fire now and the on/off switch for one routine row. A refusal and the
 * result of Fire now go to `message`, which the row shows under itself.
 */
export function useRoutineActions(routine: Routine) {
  const fire = useRunScheduleNow();
  const update = useUpdateSchedule();
  const [message, setMessage] = useState<RoutineMessage | null>(null);

  function fireNow() {
    setMessage(null);
    fire.mutate(routine.id, {
      onSuccess: () => setMessage({ text: `Fired ${routine.name}. It runs now.`, error: false }),
      onError: (err) => setMessage({ text: errorText(err), error: true }),
    });
  }

  function save(body: UpdateWorkflowScheduleRequest) {
    setMessage(null);
    update.mutate({ id: routine.id, body }, {
      onError: (err) => setMessage({ text: errorText(err), error: true }),
    });
  }

  return { fire, update, message, setMessage, fireNow, save, setEnabled: (enabled: boolean) => save({ enabled }) };
}
