# Workflow batch fan-out — design

Status: draft, needs review.
Driving use case: Customer Artifacts — one run per customer (~250), each customer needing several integration queries feeding a session, on a monthly schedule, with batch-level status tracking.

## Problem

The dag/v1 interpreter cannot express "a small DAG per item":

- A foreach body is one inline node (`validate.ts`: "foreach.body must be a single inline node object"). There is no per-item sub-DAG.
- The expression language has no variable subscripts, so N parallel foreach nodes cannot be index-joined afterward.
- The interpreter executes a wave's runnable nodes sequentially (`for...of` with `await` in `interpreter.ts`). Sibling tool nodes do not run in parallel. foreach `concurrency` gates only parked submissions, so tool/llm/set bodies run strictly serially.
- No per-node error policy exists. Any failed definition node forces the run outcome to `failed` and starves everything downstream — including the tail notify node the templates rely on, so failed runs notify nobody.
- Run listing is per-workflow only, unfiltered and unpaginated. Nothing emits a completion signal. A failed session node's `sessionId` is persisted only in checkpoint `effects`, which the wire strips.
- Batch operators work around all of this today by firing runs externally and polling GitHub commits as the source of truth.

## Decisions (proposed)

### 1. Sub-workflow node

Add a `workflow` node type: `{ type: "workflow", workflowId, input }`. Valid at top level and as a foreach body. Execution starts a child run of the referenced definition and parks until it settles, exactly like the session node's submission contract. The child run records `parentRunId`, `parentNodeId`, and `iteration`.

Each batch item becomes a real run: per-node status, reruns, and the runs list double as the batch tracker. This is why sub-workflows win over inline subgraphs — subgraphs would need new scoping, checkpoint keying, and editor work, then still lack per-item run identity.

Guards: the referenced definition must have the same owner (team scope arrives with RBAC Phase B); nesting depth 1 — a child workflow may not contain `workflow` nodes (validated statically at save and enforced at start); the node fails, not the platform, when the referenced definition is missing or deleted.

Output contract: a run's output is the checkpointed result of its stop node when the stop node declares an `output` template; otherwise the map of its terminal nodes' outputs. The parent reads `nodes.<id>.result` as with any other node (`nodes.<id>.output` is the legacy alias for the same value).

### 2. Parallel waves

Execute a wave's runnable synchronous nodes concurrently with `Promise.allSettled`, bounded (default 5). Checkpoint-per-node semantics are unchanged — each node still writes its own checkpoint row; only the scheduling changes. This makes "six sibling query nodes" actually parallel.

### 3. Per-node onError

Add `onError: "fail" | "continue"` to tool, llm, and workflow nodes (default `fail`, today's behavior). With `continue`, a failure is recorded on the checkpoint (status `failed`, `error` set) but the node activates its outgoing edges and is excluded from failure dominance; the template context exposes `nodes.<id>.error` so downstream nodes can branch on it. This also fixes failure notification: a tail notify node runs when upstream nodes carry `onError: "continue"`. Error edges (a distinct on-failure branch) stay future work; the flag covers the batch cases without new graph semantics.

### 4. Completion events

Emit a `workflow_run_status` event at `settleRun` (two-phase settle already centralizes the write). Route failed-run settlement through the existing attention system (same path approval parks use today). Expose the event on the session event stream so the web client can replace its 5-second polling.

### 5. Run listing for batches

Give `WorkflowStore` a real list method — `listRuns({ workflowId?, status?, since?, limit, cursor })` — replacing the N+1 in `listWorkflowRuns`. Add `GET /api/workflows/runs` (cross-workflow, same filters). Include `parentRunId` so a batch parent's children are one query. Surface the failed session node's `sessionId` in wire checkpoints instead of stripping it with `effects`.

### 6. Configurable limits

Move `MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR` and `ORG_ACTIVE_SESSION_CEILING` defaults behind per-org overrides on `orgs.features` (existing typed jsonb surface). Interim step (shipped 2026-08-19): the `VALET_ORG_SESSION_CEILING` env var sets `ORG_ACTIVE_SESSION_CEILING` per instance, default 100, read once at boot. A value that is not a positive integer fails api startup. In the same change, the live-session half of the count narrowed from `status != deleted` to `status = active` — `hibernated` and `archived` sessions consume no compute and no longer hold slots, so the ceiling measures concurrent activity instead of lifetime session count. Per-org overrides stay future work. Wire `LocalRunHost` concurrency to an env var. Count workflow-spawned sessions toward the org ceiling once sub-workflow runs give them identity (today they create no `agent_sessions` row and bypass the count). Per-owner fairness in the run host's claim loop is future work and needs owner-aware `listRunnable`, not a config value.

### 7. External batch firing (documentation, small hardening)

The webhook trigger (#190) is the supported surface for external runners: one `Idempotency-Key` per item makes retries safe; pace under the 30/min per-workflow limit; rotate the hook to revoke. Hardening: make the limiter's `{limit, windowMs}` per-workflow-configurable; note the limiter is per-process and needs a shared store before multi-replica deploys.

## Phasing

1. Sub-workflow node + parallel waves — makes the Customer Artifacts shape expressible.
2. onError + completion events + run listing — makes a 250-run batch operable without external polling.
3. Configurable limits + workflow-session accounting.

Out of scope: the workflows UI overhaul (parallel track), template gallery rebuild, and any change to the frozen v1 stack.

## Deviations (Phase 1 implementation)

- Starting the child run goes through the `WorkflowStore` directly (`createRun` + `requestWake`) — `LocalRunHost.start` is exactly that pair, so the engine port gained only `resolveWorkflow`, kept optional: an unwired host fails the node loudly instead of silently skipping.
- The child trigger payload's `type` is `'workflow'` (added to `WorkflowTriggerPayload`); the rendered node `input` becomes `data`.
- Parent linkage rides in `RunParams` (`parentRunId`/`parentNodeId`/`parentIteration`) — a jsonb column, so no migration.
- The parked parent waits on a new `{ kind: 'run', runId }` condition. Settle-time wake of the parent lives in the interpreter's settle paths; the host sweep independently wakes parents of settled children (lost-wake backstop). Cancel propagates to child runs as the same durable `cancel` signal `terminate()` writes.
- Owner match is exact `{ownerType, ownerId}` equality (covers identically-owned team workflows without new authz surface).
- Wave concurrency is fixed at 5 in the interpreter (`WAVE_CONCURRENCY`), not yet configurable.

## Deviations (Phase 2 — decision 3, per-node onError)

- `onError` is a definition field inside the existing `definition` jsonb, so decision 3 needs no migration.
- A `foreach` body may not set `onError`. A body has no outgoing edges, so the flag would record a policy that changes nothing; `foreach.onItemError` is the per-item policy. The validator rejects it and names `onItemError`, and the editor hides the field inside a body.
- The template context exposes `nodes.<id>.error` only for a node that failed under `continue`. A node that failed under the default policy stays absent from the context, as before decision 3, so a definition that does not opt in keeps the values `exists(nodes.<id>)` and `{{nodes.<id>}}` had. The wider reading — an entry for every failed node — was rejected: the only reader it adds is a cross-branch `when` predicate in a run that never asked for the feature, and what such a predicate sees depends on which wave evaluates it.
- A tolerated failure never activates a `fromOutput` edge. `fromOutput` only leaves `if` and `approval` nodes, and neither type carries `onError`, so this case is unreachable — the interpreter guards it anyway rather than guessing a branch from a node that produced no boolean output.
- A run whose only failures are tolerated settles `completed`. That is the point of decision 3 — the tail notify node runs, and the run stops reporting a failure the author chose to absorb. The consequence for decision 4: `outcome` alone no longer tells an operator whether a batch was clean, so a settle-report handler that wants that detail must read the run's checkpoints.

## Deviations (Phase 2 — decision 4, completion events)

- The settle report is an injected port, not a bus event. `InterpreterDeps` and `LocalRunHostDeps` gained an optional `onRunSettled(info)`, the same shape and the same seam `onApprovalPending` uses, so `packages/workflow` stays portable. `RunSettledInfo` carries `runId`, `workflowId`, `outcome`, `owner`, the parent linkage, and `settledAt` — every field already on the run row the settle path reads, so reporting costs no extra store call. A handler that needs node detail reads the checkpoints itself.
- The settle path is now one function. `finalizeSettle` runs `settleRun` → parent wake → report, and both `twoPhaseSettle` and the `terminalizing`-reclaim path go through it. The report is last on purpose: a host handler that hangs or throws can never strand a parked parent. The handler must be idempotent, because a reclaimed `terminalizing` run re-runs the whole finalization.
- Delivery is at most once, not exactly once. `listRunnable` never returns a `settled` run, so a process that dies between `settleRun` and the report loses that report and nothing reclaims the run to retry it. The failed-run notification is therefore best-effort, like the approval notification beside it. A consumer that must not miss a settle reads the run row.
- Only a FAILED, TOP-LEVEL run raises attention. `packages/api` wires `buildRunSettledAttention`, which routes through `routeAttention` — still the only writer of `notifications` rows. A child run stays silent: a 250-item batch would otherwise write 250 notification rows for one incident, and each child failure already lands on the parent's own `workflow` node checkpoint. The kind is `notification`, not `escalation`, because `resolveAudience` narrows an escalation on a team-owned run to team admins and would hide a failed batch from the people who run it. The `dedupeKey` is `{runId}:settled`.
- The child-run gate covers the sub-workflow batch shape only. Decision 7's external runner fires one TOP-LEVEL run per item through the webhook trigger, so a 250-item batch fired that way raises 250 notifications — multiplied by the audience size on a team-owned workflow. Per-workflow rate limiting or windowed aggregation in the attention router is the fix, and it is not in this phase.
- Decision 3 can silence this notification by design. A `workflow` node that carries `onError: "continue"` lets its parent settle `completed` even when every item failed, and only a `failed` outcome raises attention. An author who tolerates item failures owns the reporting, through the tail notify node decision 3 exists to unblock.
- **The 5-second run-detail poll stays.** Decision 4's "expose the event on the session event stream" is not implementable as written, and removing the poll on top of what IS implementable would be a regression. A workflow run has no session: `BusEvent` is keyed by `sessionId`, the only browser transport is `GET /api/sessions/:id/ws`, and that route authorizes against an `agent_sessions` row the run does not have. A team-owned run has no user session at all. Publishing ephemerally to the owner's `orchestrator:{userId}` session was considered and rejected for phase 2 — it needs a new `EngineEvent` variant, a bridge case, a wire variant, and a second socket on the run-detail page, and it still delivers nothing for a team-owned run and nothing at all while the socket is closed, so the query would have to keep refetching anyway. A live run view needs a run-scoped or user-scoped transport (an SSE endpoint or a user-filtered socket — `EventFilter` already accepts `userId`); that is a transport decision, and it belongs with the workflows UI overhaul that owns the run-detail page.
- No migration. The report is in-process, and the notification lands in the existing `notifications` table.

## Deviations (Phase 2 — decision 5, run listing)

- `listRuns` returns a `WorkflowRunListItem`, not a `WorkflowRun`. Returning the full run row would drag the `definition` and `params` jsonb snapshots back for every row, which is the cost the N+1 fix exists to remove. The Postgres implementation names its columns and never runs `SELECT *`.
- The filter carries no owner field. The port stays free of team-membership semantics: a caller resolves the workflow ids it may read (`ownedWorkflowIds` in `packages/api/src/workflows/service.ts`) and passes them as `workflowIds`. Authorization stays in application code, and an id the caller cannot read answers 404 — the same convention as `routes/sessions.ts`, so an unreadable workflow and a missing one are indistinguishable.
- The cursor is `(createdAt, runId)`, not `createdAt` alone. A 250-item fan-out creates many runs in the same millisecond, and a timestamp-only cursor would skip or repeat rows across pages. Both stores share `encodeRunCursor`/`decodeRunCursor` so the two cannot drift, and a cursor a store cannot read raises `WorkflowCursorError`, which the route and the agent action turn into a message naming the corrective action.
- Every millisecond value a caller supplies must be a safe integer, not merely a finite number. `created_at` is a bigint column, so `since=1.5` or a hand-edited `1.5:<runId>` cursor reaches the driver as `invalid input syntax for type bigint` — a 500 the caller cannot act on, and a divergence from the in-memory store, which accepted both. `decodeRunCursor` enforces it for both stores, and the route enforces it for `since`.
- Both `WorkflowStore` implementations run a new shared conformance suite (`conformance/runs.ts`), wired into `memory-store.runs.test.ts` and `pg-store.test.ts`. It takes a clock, because `createRun` stamps `createdAt` from the store's own clock and the same-millisecond tie cases need exact times.
- **No index, and no migration.** The `workflow_id` filter is covered by the existing `workflow_runs_workflow` index; the `created_at DESC` sort and the `params->>'parentRunId'` filter are not. Both sort or scan an already-filtered, small set at batch scale, and the N+1 was the actual cost. An expression index on `params->>'parentRunId'` would mean editing `0000_app.sql` in place — a `make dev-clean` for every developer — and Drizzle cannot express it. Measure first; add it later if a real workload needs it.
- Every run list is now paged (default 50, ceiling 200), including the per-workflow list that returned everything before. Every count in the web client goes through one `runCountLabel` helper, which appends `+` when `nextCursor` is set: a bare `runs.length` reads as a total and under-reports a workflow with more runs than one page holds. The editor's runs drawer says the list is one page instead of ending silently. A paging control belongs with the run-list rebuild in the UI overhaul.
- The web client answers an empty `workflowIds`, `status` or `outcome` array without a request. A query string cannot carry an empty repeated field, so the filter would drop out and the caller would get every readable run — the opposite of the port's any-of contract.
- The checkpoint `sessionId` was never a storage gap. `submission-node.ts` already persists it in the checkpoint `effects` jsonb, and the two wire projections (`getWorkflowRunDetail`, `workflows.get_run`) dropped it. Both now surface `sessionId` and the `workflow` node's `childRunId`, and nothing else from `effects` — receipts and repair state are interpreter bookkeeping. The run-detail page links each to the session or the child run, which is how a failed node's real output becomes reachable.
- `workflows.list_runs` gained the same reach: `workflow_id` is optional, and `parent_run_id` lists one batch parent's children in one call.

## Open questions

- Billing attribution for child runs: inherit the parent run's owner (matches schedule/event fire-time billing) — confirm.
- Team-owned workflow references: blocked on RBAC Phase B; the same-owner guard is deliberately narrow until then.
- Whether `maxItems` on foreach should warn in the editor when the trigger's declared input is a larger array (silent truncation is a footgun even at 250).
