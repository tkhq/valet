/**
 * One routine's page (docs/specs/2026-10-16-presence-hub-design.md Part D
 * step 2): the sentence, fire now, edit, enable or disable, and the run or
 * delivery history. A routine the scheduler turned off for an archived
 * thread shows its problem with the thread picker inline. A pick repins the
 * routine and turns it on again.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { WorkflowRunSummary } from "@valet/api/wire";
import { usePinnedThreadTitle } from "~/api/listener";
import { useRunScheduleNow, useUpdateSchedule, useWorkflowRuns, useWorkflowTriggers } from "~/api/workflows";
import { Button, EmptyRow, ErrorRow, LoadingRow, Switch, WorkRow, WorkSection } from "~/components/primitives";
import { RunStatusChip } from "~/components/workflows/run-status-chip";
import { TriggerDialog } from "~/components/workflows/trigger-dialog";
import { errorText } from "~/lib/error-text";
import { relativeTime } from "~/lib/relative-time";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { ProblemBadge, ThreadProblem } from "./problem-badge";
import { isRoutine, routineWhen, useRoutineSentence, type Routine } from "./routines-tab";

/** The run id prefix the scheduler gives a schedule's runs
 * (`scheduleRunId` in packages/api/src/workflows/scheduler.ts). */
export function scheduleRunPrefix(scheduleId: string): string {
  return `wfrun_sch_${scheduleId.replace(/-/g, "").slice(0, 8)}_`;
}

export function RoutinePage({ id }: { id: string }) {
  // Unscoped, so a routine of another workspace the caller can reach still opens.
  const triggersQ = useWorkflowTriggers();
  const routine = (triggersQ.data?.triggers ?? []).filter(isRoutine).find((r) => r.id === id);
  return (
    <div className="space-y-3">
      <Link to="/presence/routines" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-ink sm:min-h-0">
        ← Routines
      </Link>
      {triggersQ.isPending && <LoadingRow />}
      {triggersQ.isError && (
        <ErrorRow>{errorText(triggersQ.error, "Could not load this routine. Reload the page to try again.")}</ErrorRow>
      )}
      {triggersQ.isSuccess && routine === undefined && (
        <EmptyRow>This routine does not exist, or you cannot see it. Open Routines and pick a routine.</EmptyRow>
      )}
      {routine !== undefined && <RoutineBody routine={routine} />}
    </div>
  );
}

function RoutineBody({ routine }: { routine: Routine }) {
  const sentenceFor = useRoutineSentence([routine]);
  const fire = useRunScheduleNow();
  const update = useUpdateSchedule();
  const scope = useWorkspaceScope();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function fireNow() {
    setMessage(null);
    fire.mutate(routine.id, {
      onSuccess: () => setMessage({ text: "Fired. The routine runs now.", error: false }),
      onError: (err) => setMessage({ text: errorText(err), error: true }),
    });
  }

  function save(body: Parameters<typeof update.mutate>[0]["body"]) {
    setMessage(null);
    update.mutate({ id: routine.id, body }, { onError: (err) => setMessage({ text: errorText(err), error: true }) });
  }

  return (
    <div className="space-y-8">
      <section aria-label="Routine" className="space-y-3">
        <h1 className="break-words font-display text-2xl text-ink">{routine.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 text-base text-ink [overflow-wrap:anywhere]">{sentenceFor(routine)}</p>
          <ProblemBadge problem={routine.detail.disabledReason} />
        </div>
        <p className="text-sm text-muted">{routineWhen(routine)}</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <Switch
              checked={routine.enabled}
              disabled={update.isPending}
              onCheckedChange={(enabled) => save({ enabled })}
              aria-label={`${routine.enabled ? "Turn off" : "Turn on"} ${routine.name}`}
            />
            {routine.enabled ? "On" : "Off"}
          </label>
          <Button size="sm" disabled={fire.isPending} onClick={fireNow}>Fire now</Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
        </div>
        {message && (
          <p role={message.error ? "alert" : "status"} className={message.error ? "text-sm text-danger-500" : "text-sm text-muted"}>
            {message.text}
          </p>
        )}
        {routine.detail.disabledReason && (
          <ThreadProblem
            problem={routine.detail.disabledReason}
            ruleKind="routine"
            // The triggers list carries no owner, so the picker lists the
            // active workspace's threads, as the edit dialog does.
            workspace={scope.key}
            onPick={(thread) => save({ thread, enabled: true })}
            pending={update.isPending}
          />
        )}
      </section>

      {routine.detail.targetKind === "workflow" && routine.workflowId !== undefined
        ? <RoutineRuns routine={routine} workflowId={routine.workflowId} />
        : <RoutineDeliveries routine={routine} />}

      {editing && <TriggerDialog open onOpenChange={setEditing} editing={routine} schedulesOnly />}
    </div>
  );
}

/** A workflow routine's history: the workflow's recent runs this routine started. */
function RoutineRuns({ routine, workflowId }: { routine: Routine; workflowId: string }) {
  const runsQ = useWorkflowRuns(workflowId, { limit: 50 });
  const prefix = scheduleRunPrefix(routine.id);
  const runs = (runsQ.data?.runs ?? []).filter((run) => run.runId.startsWith(prefix));
  return (
    <WorkSection title="History" count={runsQ.isSuccess ? runs.length : undefined}>
      {runsQ.isPending && <LoadingRow className="px-4" />}
      {runsQ.isError && (
        <ErrorRow className="px-4">{errorText(runsQ.error, "Could not load the runs. Reload the page to try again.")}</ErrorRow>
      )}
      {runsQ.isSuccess && runs.length === 0 && (
        <EmptyRow className="px-4 py-3">This routine has not started a run in the workflow's last 50 runs.</EmptyRow>
      )}
      {runs.map((run) => <RunRow key={run.runId} run={run} />)}
    </WorkSection>
  );
}

function RunRow({ run }: { run: WorkflowRunSummary }) {
  return (
    <WorkRow
      title={<Link to="/presence/runs/$runId" params={{ runId: run.runId }}>Run {run.runId}</Link>}
      badge={<RunStatusChip status={run.status} outcome={run.outcome} needsApproval={run.needsApproval ?? false} />}
      time={run.createdAt}
    />
  );
}

/** An assistant routine's history: when it last fired, and where its prompts land. */
function RoutineDeliveries({ routine }: { routine: Routine }) {
  const policy = routine.detail.thread;
  const pin = policy?.mode === "existing" ? policy : undefined;
  const titles = usePinnedThreadTitle(pin);
  const pinTitle = pin ? titles[pin.threadId]?.title ?? "the thread you picked" : undefined;
  const lastFired = routine.detail.lastFiredAt;
  return (
    <WorkSection title="History">
      <WorkRow
        title={lastFired === null ? "Has not fired yet" : `Last fired ${relativeTime(lastFired)}`}
        detail={pin
          ? <>Each firing goes to <Link to="/threads/$threadId" params={{ threadId: pin.threadId }} className="hover:underline">{pinTitle}</Link>.</>
          : policy?.mode === "new"
            ? "Each firing starts a new thread."
            : "Each firing goes to this routine's thread."}
      />
    </WorkSection>
  );
}
