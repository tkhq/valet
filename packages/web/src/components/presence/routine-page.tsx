/**
 * One routine's page (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 2): the sentence as the title, the fact strip (When, Do, Runs in),
 * edit, delete, fire now, enable or disable, and the run or delivery
 * history. Edit's **Runs in** lists the routine owner's threads. A
 * routine the scheduler turned off for an archived thread shows its problem
 * with the thread picker inline. A pick repins the routine and turns it on
 * again.
 */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { WorkflowRunSummary } from "@valet/api/wire";
import { usePinnedThreadTitle } from "~/api/rule";
import { useMe, useTeams } from "~/api/settings";
import { useRunScheduleNow, useUpdateSchedule, useWorkflowRuns, useWorkflowTriggers, useWorkflows } from "~/api/workflows";
import { Button, EmptyRow, ErrorRow, LoadingRow, Switch, WorkRow, WorkSection } from "~/components/primitives";
import { RunStatusChip } from "~/components/workflows/run-status-chip";
import { TriggerDialog } from "~/components/workflows/trigger-dialog";
import { errorText } from "~/lib/error-text";
import { relativeTime } from "~/lib/relative-time";
import { PRESENCE_CRUMB, PresenceDetailPage } from "./page-shell";
import { OwnerBadge } from "./presence-rows";
import { ProblemBadge, ThreadProblem } from "./problem-badge";
import {
  isRoutine, routineReadOnly, routineReadOnlyText, routineWhen, routineWorkspace, useRoutineSentence, type Routine,
} from "./routine-helpers";
import { DeleteRoutineDialog } from "./routine-row";
import { routineAction, runsInLabel, scheduleInWords, type WorkflowNames } from "./sentences";

/** The run id prefix the scheduler gives a schedule's runs
 * (`scheduleRunId` in packages/api/src/workflows/scheduler.ts). */
export function scheduleRunPrefix(scheduleId: string): string {
  return `wfrun_sch_${scheduleId.replace(/-/g, "").slice(0, 8)}_`;
}

export { routineReadOnly } from "./routine-helpers";

export function RoutinePage({ id }: { id: string }) {
  // Unscoped, so a routine of another workspace the caller can reach still opens.
  const triggersQ = useWorkflowTriggers();
  const routine = (triggersQ.data?.triggers ?? []).filter(isRoutine).find((r) => r.id === id);
  const sentenceFor = useRoutineSentence(routine === undefined ? [] : [routine]);
  const name = routine?.name ?? "Routine";
  return (
    <PresenceDetailPage
      crumbs={[PRESENCE_CRUMB, { label: "On a schedule", to: "/presence", hash: "schedule" }, { label: name }]}
      title={routine === undefined ? name : sentenceFor(routine)}
    >
      {triggersQ.isPending && <LoadingRow />}
      {triggersQ.isError && (
        <ErrorRow>{errorText(triggersQ.error, "Could not load this routine. Reload the page to try again.")}</ErrorRow>
      )}
      {triggersQ.isSuccess && routine === undefined && (
        <EmptyRow>This routine does not exist, or you cannot see it. Open Presence and pick a routine.</EmptyRow>
      )}
      {routine !== undefined && <RoutineBody routine={routine} />}
    </PresenceDetailPage>
  );
}

/** The fact strip's values (spec Part E step 2). Do names the action and
 * Runs in names the thread, so the strip says each fact once. A workflow
 * routine starts a run, not a thread, so it has no Runs in. */
export function routineFacts(
  routine: Routine,
  workflows: WorkflowNames,
  pinTitle: string | undefined,
): readonly { term: string; value: string }[] {
  const facts = [
    { term: "When", value: scheduleInWords(routine.detail.cron, routine.detail.timezone) },
    { term: "Do", value: routineAction(routine, workflows) },
  ];
  if (routine.detail.targetKind === "assistant") {
    facts.push({ term: "Runs in", value: runsInLabel(routine.detail.thread ?? { mode: "own" }, null, "routine", pinTitle) });
  }
  return facts;
}

function RoutineBody({ routine }: { routine: Routine }) {
  const workflows = useWorkflows();
  const pin = routine.detail.thread?.mode === "existing" ? routine.detail.thread : undefined;
  const pinTitles = usePinnedThreadTitle(pin);
  const pinThreadTitle = pin ? pinTitles[pin.threadId]?.title ?? undefined : undefined;
  const fire = useRunScheduleNow();
  const update = useUpdateSchedule();
  const me = useMe();
  const teams = useTeams();
  const navigate = useNavigate();
  const readOnly = routineReadOnly(routine, me.data, teams.data?.teams);
  const readOnlyText = routineReadOnlyText(routine, teams.data?.teams);
  const workspace = routineWorkspace(routine);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
        <div className="flex flex-wrap items-start gap-3">
          <dl aria-label="Facts" className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            {routineFacts(routine, workflows.data?.workflows ?? [], pinThreadTitle).map((fact) => (
              <div key={fact.term} className="contents">
                <dt className="text-muted">{fact.term}</dt>
                <dd className="text-ink [overflow-wrap:anywhere]">{fact.value}</dd>
              </div>
            ))}
          </dl>
          <OwnerBadge ownerType={routine.detail.ownerType} />
          <ProblemBadge problem={routine.detail.disabledReason} />
        </div>
        <p className="text-sm text-muted">{routineWhen(routine, ": ")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setEditing(true)}>Edit</Button>
          <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setDeleting(true)}>Delete</Button>
          <Button size="sm" disabled={readOnly || fire.isPending} onClick={fireNow}>Fire now</Button>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <Switch
              checked={routine.enabled}
              disabled={readOnly || update.isPending}
              onCheckedChange={(enabled) => save({ enabled })}
              aria-label={`${routine.enabled ? "Turn off" : "Turn on"} ${routine.name}`}
            />
            {routine.enabled ? "On" : "Off"}
          </label>
        </div>
        {readOnly && !routine.detail.disabledReason && <p className="text-xs text-muted">{readOnlyText}</p>}
        {message && (
          <p role={message.error ? "alert" : "status"} className={message.error ? "text-sm text-danger-500" : "text-sm text-muted"}>
            {message.text}
          </p>
        )}
        {routine.detail.disabledReason && (
          <ThreadProblem
            problem={routine.detail.disabledReason}
            threadTitle={pinThreadTitle}
            workspace={workspace}
            readOnly={readOnly}
            readOnlyText={readOnlyText}
            onPick={(thread) => save({ thread, enabled: true })}
            action={readOnly ? undefined : (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit the routine</Button>
            )}
            pending={update.isPending}
          />
        )}
      </section>

      {routine.detail.targetKind === "workflow" && routine.workflowId !== undefined
        ? <RoutineRuns routine={routine} workflowId={routine.workflowId} />
        : <RoutineDeliveries routine={routine} />}

      {editing && <TriggerDialog open onOpenChange={setEditing} editing={routine} schedulesOnly workspace={workspace} />}
      <DeleteRoutineDialog
        routine={routine}
        teams={teams.data?.teams}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => { void navigate({ to: "/presence" }); }}
      />
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
      title={<Link to="/workflows/runs/$runId" params={{ runId: run.runId }}>Run {run.runId}</Link>}
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
