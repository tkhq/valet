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

## Deviations & notes

- (filled in as the implementation lands)
