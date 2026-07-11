# Workflow Run Host

> Defines the portable execution substrate for workflow runs: a checkpointed interpreter that owns its own durability, a minimal `RunHost` port for wake/timer/signal/terminate, and thin per-platform hosts for Cloudflare and Kubernetes.

## Scope

This spec covers:

- The checkpointed interpreter model (replay-free resume from persisted node results)
- The `RunHost` port and its per-platform implementations
- Durable signals (approval resume, cancellation) as store rows, not deliveries
- Durable timers and wake scheduling
- Run ownership: claims, leases, and reconciliation for workflow runs
- The checkpoint and signal data model
- How workflow runs consume the engine's Workflow Caller Contract
- Migration path off Cloudflare Workflows `step.*` memoization

### Boundary Rules

- This spec does NOT cover the workflow definition format, node types, DAG semantics, triggers, or version history — those belong to `docs/specs/workflows.md`.
- This spec does NOT cover the engine's session/submission primitives — those belong to `docs/specs/2026-05-02-portable-runtime-engine-design.md`. This spec consumes them.
- This spec does NOT cover approval policy or the unified `action_invocations` record — application-layer concerns. It covers only the durable-wait mechanics a workflow-side approval parks on.

## Why

The workflow interpreter today runs as a Cloudflare Workflows entrypoint and depends on five platform capabilities: memoized steps (`step.do`), durable timers (`step.sleep`), durable signal waits (`step.waitForEvent`), signal delivery (`sendEvent`), and termination. None of these exist on Kubernetes.

Abstracting at the `step.*` API surface is the wrong cut. "Replay a function top-to-bottom with memoized effects" is the hard core of a durable execution engine; a k8s implementation of that port means rebuilding one (or adopting Temporal, which does not run on Cloudflare — leaving two substrates, two determinism models, and one interpreter that must satisfy both).

The right cut moves durability *into the interpreter* and shrinks the substrate to something both platforms provide cheaply:

1. **Node results become first-class state.** The interpreter already runs a DAG wave loop with CAS status transitions and trace rows. It leans on `step.do` replay only because node results are not persisted as their own records. A checkpoint table keyed by `(runId, nodeId, iteration)` makes resume "read checkpoints, skip completed nodes, continue the wave loop" — no replay, no memoization, no determinism contract.
2. **The dominant step consumer is gone.** Poll-until-idle loops (the bulk of `step.do`/`step.sleep` usage, backoff-tuned against CF's step budget) are replaced by the engine's `awaitResult` primitive. What remains needing durable waits: the `wait` node (one timer), approvals (one signal wait), and per-node effect execution.
3. **Run ownership reuses the submission machinery.** Exclusive execution of a run is the same problem as exclusive execution of a submission, and gets the same answer: CAS claims, 30-second leases with heartbeat, expired-lease reclaim, reconciliation on resume.

## Architecture

```
Workflow definition (dag/v1)                     [workflows.md]
        │
Checkpointed interpreter (portable)              [this spec]
  ├── wave loop over DAG
  ├── node checkpoints  → workflow_checkpoints
  ├── signal waits      → workflow_signals
  ├── engine calls      → Workflow Caller Contract (createSession,
  │                        prompt w/ dispatchId, awaitResult, events)
  └── parks when blocked (timer or signal), persisting wake conditions
        │
RunHost port (tiny)
  ├── start(runId, params)      idempotent
  ├── wake(runId)               resume a parked run
  ├── scheduleWake(runId, at)   durable timer
  └── terminate(runId)
        │
┌───────┴────────┐
│ CF host        │  K8s host
│ CF Workflows   │  Leased worker pool:
│ driver or DO   │  claim → run-until-park → release,
│ with alarms    │  timer/lease scan loop
└────────────────┘
```

The interpreter is a portable library function: `runWorkflow(runId, deps)` where `deps` bundles the store, the engine handle, and a clock. It runs until the DAG reaches a terminal state or every runnable node is blocked, persisting checkpoints as it goes, then **parks**: it records what it is waiting for (a timer, a signal, an engine submission) and returns. The host's only job is to call it again at the right time, exactly-one-owner-at-a-time.

## Execution Model

### Checkpoints

Every node execution writes exactly one checkpoint on completion:

```typescript
interface NodeCheckpoint {
  runId: string;
  nodeId: string;
  iteration: number;          // 0 for non-foreach nodes
  status: 'completed' | 'failed' | 'skipped';
  result?: unknown;           // JSON-serializable node output
  error?: string;
  /** Values the node read from the environment (clock, generated ids). */
  effects?: Record<string, unknown>;
  attempt: number;
  createdAt: number;
}
```

Rules:

- **Effects live only inside node executors.** Clock reads, generated IDs, and any other nondeterminism a node needs are recorded in `effects` and read back on resume. The interpreter loop itself is pure over (definition, checkpoints, signals).
- **Checkpoint before external dispatch, dispatch idempotently.** A node that fires a billed or side-effecting call (LLM node, tool action, session prompt) first checkpoints its intent with the deterministic idempotency key, then dispatches. Session prompts use the submission `dispatchId` convention `workflow:{runId}:{nodeId}[:{iteration}]`; tool actions use the existing deterministic invocation id. Re-execution after a crash re-dispatches with the same key and is absorbed by the receiver. This is stronger than step memoization: it survives even a substrate that re-runs a "completed" step.
- **Checkpoint writes are CAS on `(runId, nodeId, iteration, attempt)`.** A stale owner (expired lease, delayed write) cannot overwrite a successor attempt's checkpoint.
- Checkpoints are append-only per attempt; the JSON-only value boundary from the current interpreter is preserved unchanged.

### Parking and wake conditions

When no node is runnable, the interpreter parks by persisting the run's wake conditions and returning:

```typescript
interface RunParkState {
  runId: string;
  status: 'running' | 'parked' | 'terminalizing' | 'settled';
  outcome?: 'completed' | 'failed' | 'cancelled';
  waitingOn: Array<
    | { kind: 'timer'; nodeId: string; wakeAt: number }
    | { kind: 'signal'; nodeId: string; signalType: string; timeoutAt?: number }
    | { kind: 'submission'; nodeId: string; sessionId: string; threadId: string; queueItemId: string }
  >;
  ownerId?: string;
  leaseExpiresAt?: number;
  updatedAt: number;
}
```

- `timer` waits are satisfied by `scheduleWake(runId, wakeAt)`.
- `signal` waits are satisfied when a matching unconsumed signal row exists (see Signals); the writer of the signal calls `wake(runId)`.
- `submission` waits are satisfied by the engine's submission settlement. The host subscribes to settlement (via the engine EventStream or `awaitResult` in a host-side waiter) and calls `wake(runId)`. On wake, the interpreter re-issues `awaitResult(queueItemId)`, which returns immediately for settled submissions.

A wake with no satisfied condition is harmless: the interpreter loads state, finds nothing runnable, re-parks. Spurious wakes are a performance cost, never a correctness cost.

### Signals

`sendEvent` semantics become **write a row, then wake**:

```typescript
interface RunSignal {
  runId: string;
  signalId: string;           // unique; idempotent insert
  signalType: string;         // e.g. 'approval:{nodeId}' | 'cancel'
  payload?: unknown;
  createdAt: number;
  consumedAt?: number;        // set by the interpreter when a wait absorbs it
}
```

- Signals are durable and consumed exactly once (CAS on `consumedAt`).
- A signal arriving before its wait is registered is not lost — the wait finds it on the next pass. This is what the current `step.waitForEvent` model cannot express without careful sequencing.
- Lost-wake recovery is a sweep: any parked run with an unconsumed matching signal, a due timer, or a settled awaited submission gets re-woken. This subsumes the current stuck-approval sweep.
- **Cancellation is a signal** (`signalType: 'cancel'`), not a special channel. The interpreter observes it at the next node boundary, withdraws in-flight engine work (`session.abort()`, which flows into the submission abort contract), settles the run `cancelled`, and runs terminal cleanup. `terminate(runId)` on the port is the hard-stop escape hatch for a wedged run; normal cancellation flows through the signal.

### Run ownership and reconciliation

Runs use the same claim/lease protocol as engine submissions, with the run as the claimed unit:

- **Claim**: CAS `parked|pending → running` recording `ownerId` and a 30s lease; heartbeat renews while the interpreter is executing.
- **Reclaim**: a scan loop finds runs with expired leases and re-claims them. Reconciliation is trivial by construction: load checkpoints and park state, absorb any signals/settlements that arrived meanwhile, continue the wave loop. There is no replay and therefore no replay-divergence class of bugs.
- **Settlement is two-phase** (`terminalizing → settled`), mirroring the submission contract: reserve the terminal outcome, run terminal cleanup (trace finalization, spawned-session bookkeeping), finalize. Finalization is idempotent.

## RunHost Port

```typescript
interface RunHost {
  /** Begin executing a run. Idempotent by runId: re-starting an existing run is a no-op. */
  start(runId: string, params: RunParams): Promise<void>;
  /** Resume a parked run now (signal written, submission settled, manual retry). Spurious wakes are safe. */
  wake(runId: string): Promise<void>;
  /** Durable timer. At most one pending wake per (runId); later calls with an earlier `at` move it forward. */
  scheduleWake(runId: string, at: number): Promise<void>;
  /** Hard stop: revoke the lease, mark the run for cancellation reconciliation. */
  terminate(runId: string): Promise<void>;
}
```

The port is deliberately this small. Everything correctness-critical (checkpoints, signals, leases, idempotent dispatch) lives in the interpreter + store, where it is testable in-memory and identical across platforms.

### Cloudflare host

Two acceptable shapes; either satisfies the port:

- **CF Workflows as a dumb driver** (migration-friendly): the entrypoint's `run()` is a loop of `step.do('drive', () => interpreter.driveUntilPark(runId))` + `step.sleep(untilNextWakeAt)` + `step.waitForEvent('wake')`. CF's memoization wraps only "drive until park," which is idempotent by design, so nothing depends on replay fidelity. `wake()` = `sendEvent`; `terminate()` = `instance.terminate()`.
- **Run DO with alarms** (end state): one Durable Object per run. `start`/`wake` are DO fetches; `scheduleWake` is the DO alarm; DO single-writer provides claim exclusivity for free (leases still recorded for a uniform store contract). Removes the CF Workflows dependency and its step-count budget entirely.

### Kubernetes host

A worker pool over the store — the same pattern as the engine's k8s session pool:

- `start`/`wake` insert into a wake queue (a `wake_at = now` row); workers claim runnable runs via CAS + lease and call `interpreter.driveUntilPark`.
- `scheduleWake` upserts the run's `wake_at`; a scan loop (every few seconds) promotes due timers and expired leases into the wake queue.
- Postgres advisory locks or plain CAS-claim both work; the store contract only requires that two claims never both succeed.

## Data Model

| Table | Purpose | Key fields |
|---|---|---|
| `workflow_runs` | Run state + park conditions + ownership | `id`, `workflow_id`, `definition_version_id`, `status`, `outcome`, `waiting_on` (JSON), `wake_at`, `owner_id`, `lease_expires_at`, `params`, timestamps |
| `workflow_checkpoints` | Node results (the replay replacement) | `run_id`, `node_id`, `iteration`, `attempt`, `status`, `result`, `effects`, `error`, `created_at` — PK `(run_id, node_id, iteration)` |
| `workflow_signals` | Durable signals incl. approvals and cancel | `run_id`, `signal_id` (unique), `signal_type`, `payload`, `created_at`, `consumed_at` |

These live in the application schema (workflows are an application feature), on D1 for Cloudflare and PostgreSQL for Kubernetes, with one Drizzle schema and per-dialect generated migrations — the same model as the engine schema. Existing `workflow_executions`, trace rows, and `action_invocations` are unchanged; checkpoints and signals are additive.

## Interaction with the Engine

Workflow nodes consume the engine exclusively through the Workflow Caller Contract:

| Node need | Engine primitive |
|---|---|
| Spawn a session | `engine.createSession({ id: presetSessionId, purpose: 'workflow' })` — idempotent by id |
| Prompt a session/orchestrator | `thread.prompt(content, { dispatchId: 'workflow:{runId}:{nodeId}[:{iter}]' })` — idempotent by dispatchId |
| Await the result | `thread.awaitResult(queueItemId, { resultSchema })` — resumable; replaces poll-until-idle |
| Observe progress | engine EventStream (settled/`turn_end`/`queue_state` events) |
| Read transcripts | `SessionStore.getEntries(...)` — one path for all session kinds |
| Approvals raised inside a spawned session | engine decision gates, resolved via `resolveDecision` — no workflow involvement beyond observing settlement |
| Approvals raised by the workflow itself | `workflow_signals` row + `wake(runId)` — the workflow-instance resume target of the dual-target approval model |

## Migration Path

Ordered so each step ships independently and the CF product keeps working throughout:

1. **Checkpoint table + checkpointed node executors.** Node executors write checkpoints and read them on entry (skip-if-completed). `step.do` remains as an outer wrapper but no longer carries correctness. Clock reads move into `effects`.
2. **`awaitResult` adoption.** Session/orchestrator nodes switch from poll-until-idle to submission `dispatchId` + `awaitResult`, deleting `polling.ts` usage and the two divergent transcript read paths. (Depends on the engine primitive landing.)
3. **Signals table.** Approval resume and cancellation write `workflow_signals` + wake instead of bare `sendEvent`/`terminate`; `step.waitForEvent` becomes "check signals table, else park." The stuck-approval sweep becomes the generic lost-wake sweep.
4. **Interpreter extraction.** The wave loop moves into a portable package (no `WorkflowEntrypoint` import), exposing `driveUntilPark(runId, deps)`. The CF entrypoint becomes the dumb driver.
5. **K8s host.** Implement the leased worker pool against PostgreSQL. Conformance = the shared run-host contract suite (below) plus the existing workflow integration tests running against both hosts.
6. **(Optional) CF host swap** to the Run DO with alarms, retiring the CF Workflows binding and its step budget.

Steps 1–3 are pure hardening of the current CF deployment — they reduce reliance on replay memoization even if k8s never ships.

## Conformance

Executable contract suites, mirroring the engine's conformance approach:

- **Checkpoint contract** — skip-if-completed, CAS on attempt, effects round-trip, idempotent-dispatch key derivation.
- **Signal contract** — idempotent insert, exactly-once consumption, signal-before-wait delivery, cancel observation at node boundary.
- **Run ownership contract** — single-claim exclusivity, lease expiry and reclaim, reconciliation resumes from checkpoints without duplicate external dispatch (asserted via dispatchId capture).
- **RunHost contract** — start idempotency, spurious-wake safety, timer move-forward semantics, terminate → cancellation reconciliation.

A host implementation is supported when the suites pass against it; the in-memory host is the reference implementation used by interpreter unit tests.
