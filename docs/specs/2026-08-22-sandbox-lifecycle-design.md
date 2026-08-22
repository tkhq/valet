# Sandbox lifecycle correctness — delete on settle, orphan sweep, TTL, Pending timeout

## Context

On 2026-08-22 the agents-dev cluster held 584 Sandbox CRs and 433 Pending pods
against 58 pod slots. The trigger was a scheduled workflow whose `foreach` node
fans out one `session` sandbox per item per fire. The runs settled; the
sandboxes stayed. Assistants sat Pending for 47 hours, prebuild jobs hit
DeadlineExceeded, and nothing in the platform noticed.

The incident review (sandbox allocation architecture doc) split the fix into
layers. This spec covers layer 1 — lifecycle correctness. Execution tiers and
shared sandboxes (layers 2–3) are separate future work. PR #391 already landed
two adjacent pieces: the hibernated-session reaper (`HibernationReaper`) and
the chart-level failed-pod janitor.

## The gap

Sandbox teardown was owned per session class, and one class had no owner:

| Class | Teardown before this change |
|---|---|
| Interactive session | idle sweep suspends; `HibernationReaper` destroys after retention |
| Child session | `ChildWatcher` parks at settle; retention sweep destroys |
| Workflow `session` node | **none** — no `agent_sessions` row, so both sweeps are blind to it |
| Cache-evicted, never hibernated | **none** — no DB row records the live sandbox handle |

A `wf:{runId}:{nodeId}[:{iteration}]` session provisions a sandbox through
`EngineHost.workflowSessionFor`, and nothing destroyed it when the run
settled. A 10-minute schedule with an 11-way fan-out leaks ~66 sandboxes per
hour.

## Decisions

1. **Delete on settle.** `onRunSettled` now drives
   `WorkflowSandboxReclaimer.reclaimRun` (`packages/api/src/workflows/sandbox-reclaim.ts`)
   after the failed-run attention hook. It destroys the sandbox of every
   session the run's checkpoints name (`effects.sessionId`, filtered to
   `wf:{thisRunId}:` — an `orchestrator` node's checkpoint carries the
   assistant's session id in the same slot, and that sandbox is not the
   run's to destroy). Session data is untouched; only the sandbox and its
   tokens go. Destroy, not suspend: a settled run is terminal and its
   sessions are not user-revivable, so parking buys nothing.
2. **Retry sweep, not just a hook.** `workflow_runs` gains
   `sandbox_reclaimed_at` (nullable bigint; in-place `0000_app.sql` edit +
   `addColumnsMissingFromAppliedMigrations` repair line). The stamp lands
   only when every session reclaimed cleanly. A 15-minute sweep retries
   settled rows with a NULL stamp — runs settled while the api was down,
   failed on-settle reclaims, and every run settled before the column
   existed (the incident backlog). A 5-minute settle grace keeps the sweep
   off runs the hook is still working.
3. **Uncached sessions reclaim through the derived handle.** The sandbox
   name is deterministic from the session's workspace path
   (`SandboxProvider.deriveId`), so no handle needs recording at provision
   time. Backends with provider-assigned ids (docker/local) have nothing to
   destroy once the cache entry is gone; the reclaim logs and stamps rather
   than re-sweeping forever.
4. **Race rules mirror `ChildWatcher.sweepRetention`.** Unsettled
   submissions always win, re-checked immediately before the destroy.
5. **Provider-side reconcile sweep — orphan rule only.**
   `SandboxProvider.list()` (optional; kubernetes implements it) enumerates
   what actually exists. The engine stamps the owning session id on every
   create (`SandboxCreateOpts.sessionId` → a CR annotation,
   `valet.dev/session` — an annotation because session ids contain colons
   that label values reject). `SandboxReconcileSweep`
   (`packages/api/src/engine/sandbox-reconcile-sweep.ts`, 30-minute
   interval) destroys a sandbox only when its owning session is gone from
   both the engine store and the host cache — the one case with no owner
   left to delete it through any other path.
6. **No max-lifetime kill — alert, don't auto-repair.** The incident doc
   proposed a TTL cap. Rejected during implementation (and written into
   CLAUDE.md as a repo-wide rule): an age-based destroy masks whichever
   owner failed to clean up, flattens the created−deleted leak signal the
   metrics exist to expose, and wipes legitimately long-lived active
   workspaces (an orchestrator's) on a timer. Instead the sweep REPORTS
   over-age sandboxes (`VALET_SANDBOX_AGE_REPORT_HOURS`, default 168) and
   sandboxes with no session annotation, in logs and in its `SweepReport`
   return, so a lifecycle bug pages a human. Known residual: a sandbox
   whose session was cache-evicted while running and never hibernated has
   no owner sweep; it now surfaces through the over-age report rather than
   being silently killed.

7. **Pending timeout fails terminally, and a failed fresh create cleans up
   its CR.** `waitReady` previously threw a retryable timeout for a pod
   stuck `Pending` without an `Unschedulable` verdict, so callers re-queued
   forever (the incident's assistants waited 47h). At readiness timeout it
   now diagnoses the pod (`classifyPodPending`): unscheduled → terminal
   `SandboxStartupError` naming the capacity cause; scheduled-but-pulling →
   still the retryable timeout (large images legitimately exceed the
   window). On a terminal startup failure, `create()` deletes the CR it
   created **fresh in that call** — leaving it queues phantom scheduler
   demand and its PVC holds nothing. An adopted CR is never deleted
   (decision 5's workspace-survival intent); this is the one documented
   exception to "only the session-deletion path deletes a CR".

## Metrics

All on the `@valet/engine` meter (`packages/engine/src/metrics.ts`; no-op
until the api registers a MeterProvider):

- `valet.sandbox.created` (counter) — successful provisions, recorded in
  the attachment. With `valet.sandbox.destroyed{reason}` this forms the
  created−destroyed gap that IS the leak alarm.
- `valet.sandbox.destroyed{reason}` (counter) — reasons name the
  destroying owner: `session_destroy` (attachment default),
  `run_settled`, `hibernation_retention`, `child_settled`,
  `child_retention`, `orphaned`, `failed_create`.
- `valet.sandbox.flagged{kind}` (counter) — reconcile-sweep flags that
  deliberately did NOT destroy (`over_age`, `unowned`). Re-emitted every
  sweep pass while the condition persists, so `increase(...) > 0` alerts
  cleanly. This is the alert half of "alert, don't auto-repair".

## Deviations & notes

- The TTL destroy rule (recommendation D.3 in the incident doc) was
  implemented and then removed in favor of decision 6 — see the CLAUDE.md
  section "Invariants: alert, don't auto-repair".
