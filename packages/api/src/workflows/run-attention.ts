import { actionParamsLabel, readToolScope } from "@valet/shared";
/**
 * What the api does when a workflow run settles. Two observers live here,
 * both driven by `LocalRunHost`'s `onRunSettled` hook: the failed-run
 * notification below, and the per-run thread archive at the end of the
 * file.
 *
 * Failed-run attention (batch-fanout design decision 4). A workflow run
 * that settles `failed` reaches its owner through the attention router an
 * approval park already uses, so `routeAttention` stays the only writer of
 * `notifications` rows.
 *
 * Scope is deliberate:
 *   - Only a `failed` settle notifies. A completed or cancelled run needs
 *     nobody pulled in.
 *   - Only a top-level run notifies. A batch fan-out starts one child run
 *     per item, and every child failure already lands on the parent's own
 *     `workflow` node checkpoint. Without this gate a 250-item batch writes
 *     250 notification rows for one incident.
 *   - The kind is `notification`, not `escalation`. `resolveAudience`
 *     narrows an escalation on a team-owned run to team admins, which would
 *     hide a failed batch from the people who run it.
 */
import { runEventChannel, slackEventsThreadKey } from "../services/thread-access.js";
import { eq } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { NodeCheckpoint, OnApprovalParked, OnApprovalPending, OnRunSettled, WorkflowRun, WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { ensureAssistantRuntime, loadAssistantBySessionId } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import { principalFromOwner, routeAttention, type AttentionChannelDeliverer, type AttentionDeps } from "../orchestrator/attention.js";
import { assistantExecutions, sessionThreads, workflowDefinitions } from "../schema/index.js";
import { resolveWorkflowReportTarget } from "./report-target.js";
import { workflowRunThreadKey } from "./engine-deps.js";
import { selectWork } from "../engine/wakeups-admin.js";

export function workflowApprovalHref(runId: string, nodeId: string): string {
  return `/workflows/runs/${encodeURIComponent(runId)}?gate=${encodeURIComponent(nodeId)}`;
}

/** Names the action and, when its parameters have one, what it would change,
 * so two waiting approvals for one action read differently. A parameter can
 * come from a webhook or a model. Slack renders the title as markdown, so a
 * space after "]" keeps "[text](url)" from becoming a disguised link. */
function policyGateTitle(info: { service?: string; action?: string; params?: unknown }): string {
  const label = actionParamsLabel(info.params)?.value.replaceAll("](", "] (");
  return `Approval needed: ${info.service ?? "?"}.${info.action ?? "?"}${label ? ` for "${label}"` : ""}`;
}

/** Routes an account gate to its lender and other gates to the run's audience. */
export function buildRunApprovalAttention(deps: {
  db: AppDb;
  store: Pick<WorkflowStore, "getRun">;
  channels?: AttentionChannelDeliverer[];
  access?: AttentionDeps["access"];
}): OnApprovalPending {
  return async info => {
    try {
      const run = await deps.store.getRun(info.runId);
      const owner = principalFromOwner(run?.owner);
      if (!owner) return;
      const channel = run && !run.params.origin ? runEventChannel(run.params) : undefined;
      await routeAttention({ db: deps.db, channels: deps.channels, access: deps.access }, {
        kind: "approval",
        workflowGate: { runId: info.runId, nodeId: info.nodeId, iteration: info.iteration ?? 0, ...(info.gateId ? { gateId: info.gateId } : {}) },
        owner: info.approver ? { type: "user", id: info.approver.userId } : owner,
        ...(run?.params.origin && !info.approver ? { sessionId: run.params.origin.assistantSessionId, threadId: run.params.origin.threadId } : {}),
        ...(channel ? { audienceKey: slackEventsThreadKey(channel) } : {}),
        title: info.summary ?? info.prompt ?? policyGateTitle(info),
        body: info.kind === "policy_gate" ? `Workflow run ${info.runId} is paused on ${info.nodeId}.` : info.summary ? info.prompt : undefined,
        href: workflowApprovalHref(info.runId, info.nodeId),
        dedupeKey: `${info.runId}:${info.gateId ?? `${info.nodeId}${info.iteration !== undefined && info.iteration > 0 ? `:${info.iteration}` : ""}`}`,
      });
    } catch (err) {
      // A failed notification must not prevent the run from parking.
      console.error(`workflow approval notification failed for ${info.runId}:${info.nodeId}`, err);
    }
  };
}

export interface RunSettledAttentionDeps {
  db: AppDb;
  store: Pick<WorkflowStore, "getCheckpoints" | "getRun">;
  channels?: AttentionChannelDeliverer[];
  /** Credential access for a private Slack thread's membership check (`AttentionDeps.access`). */
  access?: AttentionDeps["access"];
}

/** Budget for the failed nodes and their errors: one Slack text section.
 * A tool error can carry a whole response, so a longer summary is cut. */
const SUMMARY_CHARS = 3_000;

/**
 * Builds the `onRunSettled` handler `LocalRunHost` drives. Contained by
 * contract: the hook fires on an already-settled run, so a throw would
 * abandon a drive lease nothing reclaims. A lost notification degrades to a
 * log line — the run stays readable through the API either way.
 */
export function buildRunSettledAttention(deps: RunSettledAttentionDeps): OnRunSettled {
  return async (info) => {
    if (info.outcome !== "failed") return;
    if (info.parentRunId !== undefined) return;
    const owner = principalFromOwner(info.owner);
    if (!owner) return; // no recorded owner: no audience to resolve

    try {
      const name = await workflowName(deps.db, info.workflowId);
      const checkpoints = await deps.store.getCheckpoints(info.runId);
      // A run started from a thread is that thread's audience's
      // (`thread-access.ts`): a private thread's run notifies only them.
      const params = (await deps.store.getRun(info.runId))?.params;
      const origin = params?.origin;
      // A run a Slack channel's event started reaches that channel's audience.
      const slackChannel = params && !origin ? runEventChannel(params) : undefined;
      await routeAttention(
        { db: deps.db, channels: deps.channels, ...(deps.access ? { access: deps.access } : {}) },
        {
          kind: "notification",
          urgency: "high",
          owner,
          ...(origin ? { sessionId: origin.assistantSessionId, threadId: origin.threadId } : {}),
          ...(slackChannel ? { audienceKey: slackEventsThreadKey(slackChannel) } : {}),
          title: `Workflow run failed: ${name}`,
          body: failedNodeSummary(checkpoints),
          href: `/workflows/runs/${info.runId}`,
          // A run reclaimed while `terminalizing` re-runs settle
          // finalization, so this handler can fire twice for one run. The
          // deterministic key makes the second insert a no-op.
          dedupeKey: `${info.runId}:settled`,
        },
      );
    } catch (err) {
      console.error(`workflow failed-run notification failed for ${info.runId}:`, err);
    }
  };
}

/** The workflow's display name, falling back to its id when the definition is gone. */
async function workflowName(db: AppDb, workflowId: string): Promise<string> {
  const rows = await db
    .select({ name: workflowDefinitions.name })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, workflowId))
    .limit(1);
  return rows[0]?.name ?? workflowId;
}

/**
 * Each failed node with its whole error, one per line, so the reader can
 * act from the notification without opening the run. `foreach` body rows
 * carry a non-zero iteration and are labelled with it: the same node id can
 * fail on several items. Only a summary over `SUMMARY_CHARS` is cut, and
 * then it points to the run for the rest.
 */
export function failedNodeSummary(checkpoints: NodeCheckpoint[]): string {
  const failed = checkpoints.filter((cp) => cp.status === "failed");
  if (failed.length === 0) return "Open the run to see why it stopped.";

  // Build only up to the budget: a batch can fail on hundreds of rows, each
  // carrying a whole response body.
  let summary = "";
  for (const cp of failed) {
    const label = cp.iteration > 0 ? `${cp.nodeId}[${cp.iteration}]` : cp.nodeId;
    const line = `${summary ? "\n" : ""}${label}: `;
    const error = cp.error ?? "no error recorded";
    const room = SUMMARY_CHARS - summary.length - line.length;
    if (error.length > room) {
      return `${summary}${room > 0 ? `${line}${error.slice(0, room)}` : ""}…\n\nOpen the run to see the rest.`;
    }
    summary += `${line}${error}`;
  }
  return summary;
}

export interface RunOriginReportDeps {
  db: AppDb;
  engineHost: EngineHost;
  store: Pick<WorkflowStore, "getRun" | "getCheckpoints">;
}

/** Budget for the run's final output in the report. */
const OUTPUT_CHARS = 2_000;

/**
 * Reports a settled run to the assistant thread that started it, as a
 * `workflow.settled` signal. The thread's turn starts from the result, the
 * way a parent continues from a child's `child.settled`, so Valet can read
 * a failure, fix the workflow, and start the next run without someone
 * asking it to check. Only a top-level run that a thread started reports
 * here; a scheduled or event run has no thread waiting on it.
 *
 * Contained by contract, like the notification above. Idempotent: the
 * dispatch id is the run's, so a run reclaimed while `terminalizing`
 * reports once.
 */
export function buildRunOriginReport(deps: RunOriginReportDeps): OnRunSettled {
  return async (info) => {
    if (info.parentRunId !== undefined) return;
    try {
      const run = await deps.store.getRun(info.runId);
      if (!run) return;
      await signalOrigin(deps, run, `workflow-settled:${info.runId}`, async () => ({
        signalType: "workflow.settled",
        body: runReport(await workflowName(deps.db, info.workflowId), info.runId, info.outcome, await deps.store.getCheckpoints(info.runId)) +
          "\nContinue the workflow task now. Call workflows.get_run and inspect the relevant node results. " +
          "For failed or empty agent output, call workflows.get_node_diagnostics. " +
          "Report the outcome and the requested checks to the user. Verify external delivery from recorded tool results before claiming it succeeded.",
        attributes: { runId: info.runId, outcome: info.outcome },
      }));
    } catch (err) {
      console.error(`workflow run report to its thread failed for ${info.runId}:`, err);
    }
  };
}

/**
 * Sends a signal to the assistant thread that started `run`, once per
 * `dispatchId`. A run no thread started (scheduled, event, or a sub-run)
 * has nowhere to report.
 *
 * The signal queues as `followup`, whatever the thread's own mode. A
 * personal thread steers, and a steer admission supersedes the person's
 * queued messages, aborts the running turn, and withdraws its open
 * decision cards. A run report must wait its turn instead.
 */
async function signalOrigin(
  deps: Pick<RunOriginReportDeps, "db" | "engineHost">,
  run: WorkflowRun,
  dispatchId: string,
  signal: () => Promise<{ signalType: string; body: string; attributes: Record<string, string> }>,
): Promise<void> {
  const origin = run.params.origin;
  if (!origin) return;
  const assistant = await loadAssistantBySessionId(deps.db, origin.assistantSessionId);
  if (!assistant || assistant.archivedAt !== null) return;
  const actorUserId = run.actorUserId ?? (assistant.ownerType === "user" ? assistant.ownerId : undefined);
  if (!actorUserId) return;
  const meta = { actorUserId, orgId: assistant.orgId };
  const source = await ensureAssistantRuntime(deps, assistant, meta);
  const sourceThread = source.session.threadById(origin.threadId);
  if (!sourceThread) return;
  const { thread, priorQueueItemId } = await resolveWorkflowReportTarget(deps,
    { type: assistant.ownerType, id: assistant.ownerId }, meta, source.session, sourceThread, dispatchId);
  if (priorQueueItemId) return;
  // Execution inherits focus; reports inherit only the origin's authorization ceiling.
  // Older runs did not record that ceiling, so retain their execution restriction.
  const toolScope = run.params.originToolScope ?? run.params.toolScope;
  await thread.submitPrompt({ kind: "signal", ...(await signal()) }, { dispatchId, queueMode: "followup",
    // Continue with the starting member's authority, including private run evidence.
    // Signal turns remain non-interactive in the engine and retain normal access checks.
    author: { id: actorUserId, name: "Valet" },
    ...(toolScope !== undefined ? { metadata: { toolScope: readToolScope(toolScope) } } : {}),
  });
}

export type RunApprovalReportDeps = RunOriginReportDeps;

/**
 * Tells the thread that started a run that the run waits for approval, as a
 * `workflow.approval_needed` signal, so Valet can say which steps wait and
 * offer to approve them instead of staying silent until the run settles.
 *
 * The host fires this after a drive that opened a gate parks the run, so
 * `get_run` already lists every waiting step. Steps that park in one drive
 * share one signal, keyed on the drive's attempt. A drive that only
 * resolves some gates opens none and sends nothing. A sub-run reports
 * nothing, like the settle report: its parent's thread did not start it.
 * Contained like the reports above.
 */
export function buildRunApprovalReport(deps: RunApprovalReportDeps): OnApprovalParked {
  return async (info) => {
    try {
      const run = await deps.store.getRun(info.runId);
      if (!run || run.params.parentRunId !== undefined) return;
      await signalOrigin(deps, run, `workflow-approval:${info.runId}:${info.attempt}`, async () => ({
        signalType: "workflow.approval_needed",
        body: approvalReport(await workflowName(deps.db, run.params.workflowId), info.runId),
        attributes: { runId: info.runId },
      }));
    } catch (err) {
      console.error(`workflow approval report to its thread failed for ${info.runId}:`, err);
    }
  };
}

/** What a run waiting for approval tells the thread that started it. */
export function approvalReport(name: string, runId: string): string {
  return `Workflow "${name}" is waiting for approval. Call get_run: pendingGates lists every step that waits, ` +
    `and names the teammate who must approve a step on their shared account. Run ${runId} (/workflows/runs/${runId}).`;
}

/** What a settled run tells the thread that started it. */
export function runReport(name: string, runId: string, outcome: string, checkpoints: NodeCheckpoint[]): string {
  const link = `Run ${runId} (/workflows/runs/${runId}).`;
  if (outcome === "failed") return `Workflow "${name}" failed. ${failedNodeSummary(checkpoints)} ${link}`;
  if (outcome === "cancelled") return `Workflow "${name}" was cancelled. ${link}`;
  const stop = [...checkpoints].reverse().find((cp) => cp.status === "completed" && isStopResult(cp.result));
  const result = stop && isStopResult(stop.result) ? stop.result : undefined;
  const output = result?.output === undefined ? "" : `\nOutput: ${clip(JSON.stringify(result.output))}`;
  const message = result?.message ? `\n${clip(result.message)}` : "";
  return `Workflow "${name}" completed. ${link}${message}${output}`;
}

function isStopResult(value: unknown): value is { outcome?: string; output?: unknown; message?: string } {
  return typeof value === "object" && value !== null && "outcome" in value;
}

function clip(text: string): string {
  return text.length <= OUTPUT_CHARS ? text : `${text.slice(0, OUTPUT_CHARS)}…`;
}

export interface RunThreadArchiveDeps {
  db: AppDb;
  store: Pick<WorkflowStore, "getCheckpoints">;
  /** The engine's own session store, for the thread's key and creation time,
   * and for the state of the submission the node dispatched onto it. */
  engineStore: Pick<
    SessionStore,
    "getThread" | "getQueueItem" | "listUnsettledSubmissions" | "listDecisionGates" | "listWakeups" | "listActiveLeases"
  >;
  engineHost?: Pick<EngineHost, "liveSession" | "evictCache">;
}

/**
 * Archives the assistant thread an unattended run reported on, at the
 * moment the run settles.
 *
 * Each run gets its own thread (`engine-deps.ts#workflowRunThreadKey`), so
 * a workflow that runs every hour would add one live thread to the
 * assistant sidebar every hour. This hook is the single owner of that
 * cleanup: a settled run's thread leaves the default thread list and stays
 * readable under "Show archived". Nothing is deleted, and there is no
 * sweep or timer — a run that never settles keeps its thread, which is the
 * state the person needs to see.
 *
 * Two kinds of thread are deliberately left alone. The thread an attended
 * run was started from belongs to the person, not to the run. A `session`
 * node's thread belongs to a workflow session, which has no sidebar. The
 * thread key is what tells them apart.
 *
 * A third kind is left alone for a different reason: the run can settle
 * before the assistant turn it started finishes. An orchestrator node with
 * `wait: { mode: "none" }` completes its checkpoint at dispatch, so the run
 * reaches `stop` with the prompt still queued. The strike-cap settle in
 * `local-host.ts` aborts no submission either. In both cases the thread has
 * not yet carried the report, so this hook reads the submission's state and
 * archives only a thread whose submission has settled. Nothing re-runs
 * later: an unarchived thread is the visible state, and the person can
 * archive it themselves.
 *
 * Contained by contract, like the notification above: the run is already
 * settled when this fires, so a throw would abandon a drive lease nothing
 * reclaims. Idempotent: a run reclaimed while `terminalizing` reports
 * twice, and the second archive write is the same write.
 */
export function buildRunThreadArchive(deps: RunThreadArchiveDeps): OnRunSettled {
  return async (info) => {
    try {
      const key = workflowRunThreadKey(info.runId);
      // Grouped by thread, not deduplicated to the first checkpoint: several
      // nodes can dispatch onto one per-run thread, and ONE unsettled
      // submission among them holds the whole thread in the list.
      const byThread = new Map<string, { sessionId: string; threadId: string; queueItemIds: string[] }>();
      for (const checkpoint of await deps.store.getCheckpoints(info.runId)) {
        const dispatch = submissionDispatch(checkpoint.effects);
        if (!dispatch) continue;
        const seen = `${dispatch.sessionId}\n${dispatch.threadId}`;
        const group = byThread.get(seen);
        if (group) group.queueItemIds.push(dispatch.queueItemId);
        else byThread.set(seen, { ...dispatch, queueItemIds: [dispatch.queueItemId] });
      }
      for (const dispatch of byThread.values()) {
        const thread = await deps.engineStore.getThread(dispatch.sessionId, dispatch.threadId);
        if (!thread) {
          // A thread a node dispatched onto should still be there. Report
          // it rather than archive nothing in silence; a key that does not
          // match is ordinary (an origin thread, or a session node's own).
          console.debug(
            `workflow run thread archive: run ${info.runId} recorded thread ${dispatch.threadId} ` +
              `on session ${dispatch.sessionId}, which the engine store no longer holds.`,
          );
          continue;
        }
        // The run's thread: the plain key, or its channel's (`workflowRunThreadKey`).
        if (thread.key !== key && !(thread.key?.startsWith("slack-events:") && thread.key.endsWith(`:workflow:${info.runId}`))) continue;
        const items = await Promise.all(
          dispatch.queueItemIds.map((itemId) => deps.engineStore.getQueueItem(dispatch.sessionId, itemId)),
        );
        const open = items.findIndex((item) => item?.status !== "settled");
        if (open >= 0) {
          console.debug(
            `workflow run thread archive: run ${info.runId} settled while submission ` +
              `${dispatch.queueItemIds[open]} is ${items[open]?.status ?? "no longer recorded"} — ` +
              `leaving thread ${dispatch.threadId} in the list.`,
          );
          continue;
        }
        // Background work on the thread (a process, a watch, a timer, a
        // hold) still reports there. Archiving would hide its signals, and
        // stopping it is a person's choice, so the thread stays in the list
        // (fix wave 3, group C).
        const [wakeups, leases] = await Promise.all([
          deps.engineStore.listWakeups(dispatch.sessionId, ["pending", "running"]),
          deps.engineStore.listActiveLeases(dispatch.sessionId),
        ]);
        if (selectWork({ wakeups, leases }, { threadId: thread.id }).length > 0) {
          console.debug(
            `workflow run thread archive: run ${info.runId} settled with background work open on ` +
              `thread ${dispatch.threadId}; leaving the thread in the list.`,
          );
          continue;
        }
        await deps.db
          .insert(sessionThreads)
          .values({
            id: thread.id,
            sessionId: dispatch.sessionId,
            createdAt: thread.createdAt,
            archivedAt: info.settledAt,
          })
          .onConflictDoUpdate({ target: sessionThreads.id, set: { archivedAt: info.settledAt } });
        // Only a per-run report execution owns this cache lifetime. Preserve
        // durable history, sandbox files, and ordinary origin conversations.
        if (deps.engineHost) {
          const [execution] = await deps.db.select().from(assistantExecutions)
            .where(eq(assistantExecutions.sessionId, dispatch.sessionId)).limit(1);
          if (execution?.conversationKey !== thread.key) continue;
          if ((await deps.engineStore.listDecisionGates(dispatch.sessionId)).some(gate => gate.status === "pending")) continue;
          if ((await deps.engineStore.listUnsettledSubmissions(dispatch.sessionId)).length > 0) continue;
          const live = deps.engineHost.liveSession(dispatch.sessionId);
          if (live?.listThreads().some(t => t.runningItemId() !== undefined)) continue;
          deps.engineHost.evictCache(dispatch.sessionId);
        }
      }
    } catch (err) {
      console.error(`workflow run thread archive failed for ${info.runId}:`, err);
    }
  };
}

/**
 * The session, thread and submission a node recorded when it dispatched
 * (`@valet/workflow`'s `submission-node.ts` writes them into the node's
 * checkpoint effects). Returns null for every other node.
 *
 * The queue item id comes back with the thread because the run and the
 * submission settle independently: a `wait: { mode: "none" }` node completes
 * its checkpoint at dispatch, so the thread's own state is the only way to
 * tell a finished turn from a queued one.
 */
function submissionDispatch(
  effects: Record<string, unknown> | undefined,
): { sessionId: string; threadId: string; queueItemId: string } | null {
  const sessionId = effects?.sessionId;
  const receipt = effects?.receipt;
  if (typeof sessionId !== "string") return null;
  if (typeof receipt !== "object" || receipt === null) return null;
  if (!("threadId" in receipt) || !("queueItemId" in receipt)) return null;
  const threadId = receipt.threadId;
  const queueItemId = receipt.queueItemId;
  if (typeof threadId !== "string" || typeof queueItemId !== "string") return null;
  return { sessionId, threadId, queueItemId };
}
