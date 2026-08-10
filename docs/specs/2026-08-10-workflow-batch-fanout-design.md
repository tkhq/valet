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

Output contract: a run's output is the checkpointed result of its stop node when the stop node declares an `output` template; otherwise the map of its terminal nodes' outputs. The parent reads `nodes.<id>.output` as with any other node.

### 2. Parallel waves

Execute a wave's runnable synchronous nodes concurrently with `Promise.allSettled`, bounded (default 5). Checkpoint-per-node semantics are unchanged — each node still writes its own checkpoint row; only the scheduling changes. This makes "six sibling query nodes" actually parallel.

### 3. Per-node onError

Add `onError: "fail" | "continue"` to tool, llm, and workflow nodes (default `fail`, today's behavior). With `continue`, a failure is recorded on the checkpoint (status `failed`, `error` set) but the node activates its outgoing edges and is excluded from failure dominance; the template context exposes `nodes.<id>.error` so downstream nodes can branch on it. This also fixes failure notification: a tail notify node runs when upstream nodes carry `onError: "continue"`. Error edges (a distinct on-failure branch) stay future work; the flag covers the batch cases without new graph semantics.

### 4. Completion events

Emit a `workflow_run_status` event at `settleRun` (two-phase settle already centralizes the write). Route failed-run settlement through the existing attention system (same path approval parks use today). Expose the event on the session event stream so the web client can replace its 5-second polling.

### 5. Run listing for batches

Give `WorkflowStore` a real list method — `listRuns({ workflowId?, status?, since?, limit, cursor })` — replacing the N+1 in `listWorkflowRuns`. Add `GET /api/workflows/runs` (cross-workflow, same filters). Include `parentRunId` so a batch parent's children are one query. Surface the failed session node's `sessionId` in wire checkpoints instead of stripping it with `effects`.

### 6. Configurable limits

Move `MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR` and `ORG_ACTIVE_SESSION_CEILING` defaults behind per-org overrides on `orgs.features` (existing typed jsonb surface). Wire `LocalRunHost` concurrency to an env var. Count workflow-spawned sessions toward the org ceiling once sub-workflow runs give them identity (today they create no `agent_sessions` row and bypass the count). Per-owner fairness in the run host's claim loop is future work and needs owner-aware `listRunnable`, not a config value.

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

## Open questions

- Billing attribution for child runs: inherit the parent run's owner (matches schedule/event fire-time billing) — confirm.
- Team-owned workflow references: blocked on RBAC Phase B; the same-owner guard is deliberately narrow until then.
- Whether `maxItems` on foreach should warn in the editor when the trigger's declared input is a larger array (silent truncation is a footgun even at 250).
