# Engine v2 Phase 3 — Sandbox Attachment + Lazy Warming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instant agent, background workspace — sessions start turns before the container exists, sandbox death mid-turn is a retryable tool error plus a background re-provision (never a session error), long execs run in job mode, and every provider passes one conformance suite. Plus the Phase-2 carried item: attempt-fenced EventStream appends.

**Architecture:** The engine stops awaiting `provider.create` at session construction. A new `SandboxAttachment` state machine (`detached → provisioning → ready | error`) owns the raw `Sandbox` handle and a monotonic **epoch**; a `PolicySandbox` wrapper implements the `Sandbox` interface over it and is what `Session.sandbox` / `ToolContext.sandbox` expose. Every operation: pre-dispatch abort check → await readiness (bounded, then structured `workspace_provisioning` error) → dispatch tagged with the current epoch → post-completion epoch + abort check (superseded results are discarded). Transport failure marks the attachment degraded and kicks a background re-provision under a new epoch. Cold turns get a system-prompt hint; clients get `sandbox_status` events. Long execs go through an in-process job API (spawn + poll with offsets) mirroring the sandboxd job contract.

**Tech Stack:** TypeScript, Node 22, better-sqlite3 + Drizzle, dockerode-less Docker CLI (`docker exec` via child_process, as today), Hono + @hono/node-ws, Vite/React 19 + Zustand, vitest.

**Source specs:** `docs/specs/2026-05-02-portable-runtime-engine-design.md` — lifecycle decoupling §1503–1519, provider contract §1521–1614, RPC/job contract §1616–1640, effect fencing §1186–1203, `sandbox_status` event §1421. `docs/specs/2026-07-11-sandbox-runtime-v2-design.md` — Long-Running Exec, Attachment Epochs and Fencing, Health and Failure. Roadmap: `docs/plans/2026-07-11-engine-v2-local-e2e-roadmap.md` Phase 3.

## Global Constraints

- Pre-1.0 migration policy: edit `packages/store-sqlite/migrations/sqlite/0000_lonely_lizard.sql` in place if schema changes; `rm ~/.valet/app.db`; no numbered migrations. (This phase likely needs NO schema change — fence validation reads existing `engine_queue_items`.)
- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md type-safety rules).
- Every new provider/wrapper behavior lands with its conformance- or unit-suite test in the same task.
- Kill-container-mid-exec recovery is a local test in this phase, not deferred.
- Legacy packages (`worker`, `client`, `runner`) untouched. Modal backend untouched (sandboxd itself is a later, separate track — this phase is the engine-side contracts against docker/local/virtual).
- pi-agent-core / pi-ai pinned at 0.73.0.
- All timestamps ms epoch; ids via the existing `uid(prefix)` helper.
- Run `pnpm --filter @valet/engine test`, `pnpm --filter @valet/store-sqlite test`, and `pnpm typecheck` before every commit claim. Docker-gated suites must skip cleanly when the daemon is absent.
- Node 22 (`source ~/.nvm/nvm.sh && nvm use`); Docker via Rancher Desktop.

## Locked Design Decisions

The specs leave gaps; these are decided. Do not re-open them mid-task — flag concerns to the coordinator instead.

1. **Provider contract aligns to spec.** `SandboxProvider` gains `readonly backend: string` and `capabilities(): SandboxCapabilities` (`{ snapshot: 'memory'|'filesystem'|'none'; persistentWorkspace: boolean; tunnels: boolean; warmPool: boolean; coldStartEstimateMs?: number }`). `SandboxStatus.state` moves to the spec states `'provisioning' | 'ready' | 'idle' | 'snapshotting' | 'released' | 'error'` (mapping: creating→provisioning, running→ready, stopped→released). Values: virtual `{snapshot:'none', persistentWorkspace:false, tunnels:false, warmPool:false, coldStartEstimateMs:0}`, local `{snapshot:'none', persistentWorkspace:true, tunnels:false, warmPool:false, coldStartEstimateMs:0}`, docker `{snapshot:'filesystem', persistentWorkspace:true, tunnels:false, warmPool:false, coldStartEstimateMs:8000}`. No multi-provider registry this phase (single provider per host, as today) — registry lands with Phase 4's principal model.
2. **`SandboxAttachment` is engine-owned** (`packages/engine/src/sandbox/attachment.ts`). State: `'detached' | 'provisioning' | 'ready' | 'error'`; `epoch: number` starting at 1 on first provision, incremented on every re-provision; holds `provider`, `createOpts`, current raw `Sandbox | null`. API: `warm(): void` (fire-and-forget, single-flight provision kick), `ensureReady(opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ sandbox: Sandbox; epoch: number }>`, `reportFailure(epoch: number, err: unknown): void` (degradation: if `epoch` is current, mark superseded + background re-provision), `currentEpoch(): number`, `isSuperseded(epoch: number): boolean`, `state`, `sandboxId: string | undefined`, `onStatus(cb: (s: AttachmentStatus) => void)`, `destroy(): Promise<void>`. Re-provision order per spec: mark old epoch superseded FIRST, then best-effort destroy the old sandbox, then provision the new one and only then report ready. A pre-existing concrete `Sandbox` (tests, `CreateSessionOptions.sandbox` as object) constructs the attachment already `ready` at epoch 1.
3. **`PolicySandbox` wrapper** (`packages/engine/src/sandbox/policy.ts`) implements `Sandbox` over an attachment. Every operation: (a) pre-dispatch `signal?.aborted` check (exec only — file ops have no signal today; wrapper checks an optional per-op signal where the interface carries one); (b) `ensureReady({ timeoutMs: readyTimeoutMs })` — on timeout throw `WorkspaceProvisioningError`; (c) capture `epoch` at dispatch; (d) invoke the raw op; (e) post-completion: if `attachment.isSuperseded(epoch)` throw `SandboxSupersededError` (the result is discarded, never returned); (f) on raw-op rejection: call `attachment.reportFailure(epoch, err)` and rethrow as `SandboxUnavailableError` (preserving the cause) — EXCEPT errors that are command-level, not transport-level: an `ExecResult` with non-zero exit is a normal return, and file-op `ENOENT`/`EISDIR`-class errors rethrow untouched (they are user-visible tool outcomes, not degradation). Degradation classification: only rejections from `exec`/`execJob`/`pollJob` and fs ops whose message matches container-death signatures (`/No such container|is not running|Connection refused|socket hang up/i`) — plus any rejection from a `docker exec` transport — degrade; plain fs errors on local/virtual never degrade. Additionally the wrapper owns: default `maxOutputBytes` = 262_144 when the caller passes none, and write-with-parent-creation (attempt `writeFile`/`writeBinary`; on rejection `mkdir` the parent recursively and retry ONCE). Providers get thinner: DELETE the `fs.mkdir(dirname…)` pre-write calls from `LocalSandbox`/`DockerSandbox` write paths. **Deliberate spec deviation, do not "fix":** path resolution stays provider-side (Docker's host/container dual mapping is inherently provider-specific); the wrapper does not resolve paths.
4. **Structured tool errors ride the message.** New errors in `packages/engine/src/errors.ts`: `WorkspaceProvisioningError` (code `workspace_provisioning`), `SandboxSupersededError` (code `sandbox_superseded`), `SandboxUnavailableError` (code `sandbox_unavailable`) — each `extends Error` with `readonly code: string` and a message that STARTS with `[<code>] ` followed by actionable guidance including retryability, e.g. `[sandbox_unavailable] sandbox connection lost mid-operation; the command may or may not have run. The workspace is re-provisioning in the background — retry shortly.` Thrown errors propagate through `ToolDef.execute` → pi-agent-core marks the tool result as an error with that message. No new tool-result envelope.
5. **Lazy session creation.** `Engine.materializeSandbox` no longer awaits `provider.create`: it constructs a `SandboxAttachment` (detached) + `PolicySandbox` and returns them synchronously-shaped (`Promise` kept for signature compat). `Session` gains `readonly attachment: SandboxAttachment`; `session.sandbox` is the `PolicySandbox`. `Session.toData().sandboxId` becomes `attachment.sandboxId` (may be undefined until first provision — `SessionData.sandboxId` is already optional). `session.destroy()` calls `attachment.destroy()`. Warm kick: at claimed-turn start (`Thread.runTurn`, before the LLM call) call `session.attachment.warm()` — turn and provision proceed in parallel. `createSession` does NOT warm (admission alone shouldn't bill a container; the first turn does).
6. **Ready-timeout configuration:** `CreateSessionOptions.sandboxReadyTimeoutMs?: number`, default `SANDBOX_READY_TIMEOUT_MS = 60_000` (constant in `sandbox/policy.ts`).
7. **Cold-attachment model hint.** In `Thread.runTurn`, when `session.attachment.state !== 'ready'`, overlay the system prompt for that turn (same overlay/restore idiom as `applyRoleForTurn`, composing WITH the role overlay — hint applies after role): append `\n\n[workspace status] The workspace sandbox is provisioning (~{Math.ceil(estimateMs/1000)}s). Filesystem and shell tools will wait for it; sequence non-filesystem work first.` where `estimateMs` = `provider.capabilities().coldStartEstimateMs ?? 10_000`. Restored unconditionally in the turn's `finally`.
8. **`sandbox_status` events.** New `EngineEvent` member: `{ type: "sandbox_status"; sandboxId?: string; state: "provisioning" | "ready" | "idle" | "snapshotting" | "released" | "error"; epoch: number; estimateMs?: number }` (session-scoped, no threadId). `Session` subscribes to `attachment.onStatus` in its constructor and emits durably with deterministic eventKey `sandbox:{epoch}:{state}` (idempotent — re-provision loops can't spam the log). Emitted transitions this phase: provisioning, ready, error, released (destroy).
9. **Job-mode exec.** `Sandbox` gains OPTIONAL members: `execJob?(command: string, opts?: ExecOpts): Promise<{ execId: string }>`, `pollJob?(execId: string, offset: number): Promise<JobPoll>` with `type JobPoll = { status: "running" | "done" | "failed"; exitCode?: number; output: string; nextOffset: number }` (output is the slice from `offset`; `failed` = job infrastructure failure, non-zero exit is `done` + exitCode), `cancelJob?(execId: string): Promise<void>`. All three of virtual/local/docker implement it (virtual: run the command inline on `execJob`, store the result, polls return it). Local/docker: spawn the same child-process path as sync exec but detached from the request, buffer stdout+stderr interleaved into one `output` string capped at `maxOutputBytes`, track in a `Map<execId, JobState>`; `cancelJob` kills the child (SIGKILL); job entries evict 5 minutes after terminal poll-ability (keep it simple: delete on first poll that observes terminal status + a `setTimeout(unref)` sweeper as backstop). Job state is process-memory only — engine restart loses jobs; reconciliation's rest-state repair already turns the interrupted tool call into an error (that is the designed behavior, mirror of sandboxd).
10. **Bash tool gains `timeout`.** `bash` tool parameter `timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 }))` — seconds; default 120. Effective `timeoutMs = timeout * 1000`. Mode selection in the tool: if `timeoutMs > JOB_MODE_THRESHOLD_MS (= 60_000)` AND `ctx.sandbox.execJob` exists → job mode: `execJob`, then poll every `JOB_POLL_INTERVAL_MS (= 2_000)` accumulating output until terminal or deadline (deadline → `cancelJob` + report timedOut), honoring `ctx.signal` (abort → `cancelJob`, then throw abort). Poll rejection = attachment degradation (the wrapper's `pollJob` already reports failure + throws `SandboxUnavailableError`) — the job is NOT the failure, the transport is; the tool lets the structured error propagate. Otherwise sync `exec(command, { signal, timeout: timeoutMs })`. Constants exported from `builtin-tools/index.ts`.
11. **Sandbox provider conformance suite** (`packages/engine/src/test-helpers/sandbox-contract.ts`): `runSandboxContract(name, ctx: { factory: () => Promise<{ sandbox: Sandbox; cleanup?: () => Promise<void> }>; capabilities: SandboxCapabilities })` — tests RAW providers (not the wrapper; wrapper semantics are unit-tested in its own suite): fs round-trips (utf8 + binary), readdir/stat/mkdir/rm(recursive), exec stdout/stderr/exitCode, exec cwd + env injection, `timeout` forwarding (`timedOut: true` + prompt return), `maxOutputBytes` truncation (`truncated: true`), abort-signal best-effort (skip assert where unsupported — gate on a `supportsAbort` flag; virtual skips), job mode create/poll-to-done with offset-based incremental reads (no re-delivered bytes), job cancel. Runs against virtual + local unconditionally; docker via `describe.skipIf(!dockerAvailable())` where `dockerAvailable()` probes `docker info` once (10s timeout, memoized). Docker suite lives in `packages/sandbox-docker/test/`, local in `packages/sandbox-local/test/`, virtual in `packages/engine/test/`.
12. **Fenced EventStream appends (Phase-2 carried item, spec §1198).** `EventStream.append(event, eventKey, fence?: WriteFence)` — when `fence` is provided the implementation MUST verify `fence.attemptId` is the submission's current attempt and reject with `StaleAttemptError` otherwise. `SqliteEventStream`: constructor unchanged; the append transaction (already IMMEDIATE) adds a `SELECT attempt_id FROM engine_queue_items WHERE id = ?` check. `InMemoryEventStream`: constructor gains optional `opts?: { fenceCheck?: (fence: WriteFence) => boolean }`; `InMemoryStore` gains a public sync `isCurrentAttempt(itemId: string, attemptId: string): boolean` to wire it. `Session.emit` gains `opts.fence?: WriteFence`; `Thread` passes its turn fence on live-execution emissions inside a claimed turn (`message_start`, `message_update`, `message_end`, `tool_start`, `tool_end`, `status`, `turn_end`, `error` when in-turn). Settlement/gate events keep deterministic keys and NO fence (they are legitimately emitted by reconcilers that aren't the original attempt). `Session.emit` RETHROWS `StaleAttemptError` (the zombie's stop signal); all other append failures stay log-and-continue. EventStream conformance suite grows the fence cases.
13. **Wire + web:** bridge maps `sandbox_status` → new `WireEvent` `{ type: "sandbox.status"; state: string; epoch: number; estimateMs?: number }` (durable → carries offset). Web: `SessionStreamState.sandbox?: { state: string; epoch: number }` updated by the WS reducer; `SessionHeader` renders an ambient chip (e.g. `workspace: provisioning…` amber / `ready` green dot / `error` red) — subtle, no spinner, no layout shift. No REST bootstrap for it this phase (chip appears on first event; absent = unknown = render nothing).
14. **Degradation ≠ session error, ever.** No code path introduced this phase may settle a submission `failed` because of a sandbox transition. The tool error is the model's problem; the attachment heals in the background. The E2E test asserts the session stays usable and the submission settles by normal turn logic.
15. **Existing engine tests keep passing without rewrites**: tests that pass a concrete `Sandbox` object in `CreateSessionOptions.sandbox` get ready-at-epoch-1 attachments (decision 2), so behavior is identical. Tests that pass `SandboxCreateOpts` now provision lazily — any test that asserted `provider.create` was called during `createSession` must move that assertion to first-turn/warm time.

---

### Task 1: Provider contract alignment — capabilities, backend, spec status states, structured errors

**Files:**
- Modify: `packages/engine/src/types.ts` (`SandboxProvider`, `SandboxCapabilities`, `SandboxStatus`, `JobPoll`, optional job members on `Sandbox`, `sandbox_status` EngineEvent member, `CreateSessionOptions.sandboxReadyTimeoutMs`)
- Modify: `packages/engine/src/errors.ts` (three new error classes)
- Modify: `packages/engine/src/providers/sandbox/virtual.ts` (backend, capabilities, status mapping, job mode)
- Modify: `packages/sandbox-local/src/sandbox.ts`, `packages/sandbox-docker/src/sandbox.ts` (backend, capabilities, status mapping — job mode comes in Task 4)
- Modify: `packages/engine/src/index.ts` (exports)
- Test: `packages/engine/test/sandbox-types.test.ts` (status mapping + error shape unit tests)

**Interfaces produced (exact):** decisions 1, 4, 9 verbatim — `SandboxCapabilities`, `SandboxProvider.backend/capabilities()`, `SandboxStatus.state` union, `JobPoll`, `execJob/pollJob/cancelJob` optionals, error classes with `readonly code` and `[<code>] ` message prefixes, EngineEvent `sandbox_status` member (decision 8 shape).

- [ ] **Step 1:** Write failing tests: each provider's `capabilities()` returns the exact decision-1 values; `status()` of a live/absent sandbox returns `ready`/`released`; `new WorkspaceProvisioningError(30000).message` starts with `[workspace_provisioning]`; same for the other two errors.
- [ ] **Step 2:** Add types + errors; update the three providers (virtual gets its trivial job-mode implementation here since it's ~20 lines; local/docker only backend/capabilities/status this task). Fix all compile fallout (`packages/api` uses of `SandboxStatus` if any).
- [ ] **Step 3:** Green: `pnpm --filter @valet/engine test`, `pnpm --filter @valet/sandbox-local test`, `pnpm --filter @valet/sandbox-docker test` (if suites exist), `pnpm typecheck`.
- [ ] **Step 4:** Commit — `feat(engine): spec-aligned sandbox provider contract (capabilities, status states, structured errors)`.

---

### Task 2: SandboxAttachment + PolicySandbox

**Files:**
- Create: `packages/engine/src/sandbox/attachment.ts`
- Create: `packages/engine/src/sandbox/policy.ts`
- Modify: `packages/engine/src/index.ts` (exports)
- Test: `packages/engine/test/sandbox-attachment.test.ts`

**Interfaces:**
- Consumes: Task 1's contract types + errors.
- Produces: decisions 2, 3, 6 verbatim. `AttachmentStatus = { state: 'detached'|'provisioning'|'ready'|'error'|'released'; sandboxId?: string; epoch: number; estimateMs?: number }`. `new SandboxAttachment(provider: SandboxProvider, createOpts: SandboxCreateOpts)` and `SandboxAttachment.forSandbox(sandbox: Sandbox)` (ready at epoch 1, no provider — `reportFailure`/`reprovision` on it transitions to `error` and stays there; used by tests/embedders). `new PolicySandbox(attachment, { readyTimeoutMs })`.

**Test plan (write first, all against a controllable `FakeProvider` whose `create` resolves on command):**
1. Lazy: constructing attachment + wrapper calls `provider.create` zero times.
2. `warm()` kicks exactly one `create` even when called 5× concurrently (single-flight).
3. First op awaits readiness: start `readFile`, resolve `create` 50ms later → op completes; `state === 'ready'`, epoch 1.
4. Ready-timeout: `create` never resolves; `readFile` rejects with `WorkspaceProvisioningError` within ~readyTimeoutMs (use 100ms in test); attachment still `provisioning` (a timeout is not degradation).
5. Degradation + re-provision: ready sandbox whose `exec` rejects with `Error("No such container abc")` → op rejects `SandboxUnavailableError`; attachment transitions provisioning; after fake `create` resolves again → epoch 2, next op succeeds; `onStatus` saw `provisioning(epoch2)` then `ready(epoch2)`.
6. Supersession discard: op A dispatched at epoch 1 hangs; `reportFailure(1, …)` triggered by op B; re-provision to epoch 2 completes; op A's underlying promise then resolves successfully → wrapper rejects op A with `SandboxSupersededError` (result discarded).
7. Stale failure ignored: `reportFailure(1, …)` when current epoch is 2 → no state change, no extra `create`.
8. Non-degrading errors: ready sandbox `readFile` rejects `ENOENT` → rethrown as-is, state stays `ready`, no re-provision.
9. Write-parent-retry: raw `writeFile` rejects once (parent missing), wrapper calls `mkdir` + retries → succeeds with exactly 2 write attempts + 1 mkdir.
10. Pre-dispatch abort: `exec` with an already-aborted signal rejects immediately, raw `exec` never called.
11. Default output limit: `exec` with no `maxOutputBytes` passes 262_144 to the raw op.
12. `destroy()`: destroys the raw sandbox when present, cancels in-flight provisioning (subsequent ops reject), emits `released` status.
13. `forSandbox`: ops pass through immediately; epoch 1; no provider calls.

- [ ] **Step 1:** Write the failing suite (above, each its own `it`).
- [ ] **Step 2:** Implement `attachment.ts` then `policy.ts` per decisions 2–3.
- [ ] **Step 3:** Green + full engine suite + `pnpm typecheck`.
- [ ] **Step 4:** Commit — `feat(engine): SandboxAttachment epochs + PolicySandbox lazy wrapper`.

---

### Task 3: Engine/Session/Thread integration — lazy create, warm-on-claim, cold hint, sandbox_status

**Files:**
- Modify: `packages/engine/src/engine.ts` (`materializeSandbox` → attachment construction; no awaited `create`)
- Modify: `packages/engine/src/session.ts` (hold `attachment`, wire `onStatus` → `emit`, `toData().sandboxId`, `destroy`, plumb `sandboxReadyTimeoutMs`)
- Modify: `packages/engine/src/thread.ts` (`runTurn`: `attachment.warm()` + cold-hint overlay per decision 7)
- Modify: providers in `packages/sandbox-local`/`sandbox-docker`: delete pre-write `mkdir` (wrapper owns it now, decision 3)
- Test: `packages/engine/test/lazy-attachment.test.ts`; existing suites updated per decision 15

**Interfaces:**
- Consumes: Tasks 1–2. `Session.attachment: SandboxAttachment` (public readonly); `session.sandbox` remains typed `Sandbox` (now a `PolicySandbox`).
- Produces: `sandbox_status` emissions with eventKey `sandbox:{epoch}:{state}`; cold-hint overlay text (decision 7 verbatim).

**Test plan (fake LLM per existing happy-path idiom, FakeProvider with delayed create):**
1. Exit-criterion "instant agent": prompt a fresh session whose provider `create` resolves only after the assertion — first `message_start`/`text_delta` events arrive while attachment is still `provisioning` (turn text from a scripted model that calls no tools).
2. Warm kicked on claim: after a no-tool turn completes, `provider.create` was called exactly once (decision 5: warm fires at turn start even when no tool touches the sandbox), and zero times after `createSession` alone.
3. Cold hint: scripted model captures the system prompt (fake LLM records it) → contains `[workspace status]` when cold; a second turn after readiness does NOT contain it; role overlay + hint compose (role text AND hint both present).
4. Tool waits then succeeds: model calls `read` while provisioning; create resolves 100ms in; tool result is the file content (no error).
5. Tool provisioning-timeout: `sandboxReadyTimeoutMs: 100`, create never resolves → tool result is an error containing `[workspace_provisioning]`; the TURN still completes (`turn_end`), submission settles `completed`.
6. `sandbox_status` events: durable log contains `sandbox:1:provisioning` then `sandbox:1:ready` exactly once each (appendOnce holds across a re-emit).
7. `toData().sandboxId` is undefined before provision, set after ready.
8. Existing suites (`happy-path`, `kill-mid-turn`, `kill-mid-gate`, `reconciliation`, `queue-modes`, `decision-gate`, …) green — fix only per decision 15.

- [ ] **Step 1:** Write the failing lazy-attachment suite.
- [ ] **Step 2:** Implement engine/session/thread changes; slim the two providers' write paths.
- [ ] **Step 3:** Full engine suite green (fix fallout per decision 15) + typecheck.
- [ ] **Step 4:** Commit — `feat(engine): lazy sandbox attachment — warm-on-claim, cold-turn hint, sandbox_status events`.

---

### Task 4: Job-mode exec — providers + bash tool

**Files:**
- Modify: `packages/sandbox-local/src/sandbox.ts`, `packages/sandbox-docker/src/sandbox.ts` (execJob/pollJob/cancelJob per decision 9)
- Modify: `packages/engine/src/sandbox/policy.ts` (wrap the three job ops: readiness + epoch + degradation like any op)
- Modify: `packages/engine/src/builtin-tools/index.ts` (bash `timeout` param + mode selection per decision 10; export `JOB_MODE_THRESHOLD_MS`, `JOB_POLL_INTERVAL_MS`, `BASH_DEFAULT_TIMEOUT_S = 120`)
- Test: `packages/sandbox-local/test/job-mode.test.ts`, `packages/engine/test/bash-job-mode.test.ts`

**Interfaces:** decision 9's `JobPoll` + decision 10's constants, verbatim.

**Test plan:**
1. Local provider: `execJob("i=0; while [ $i -lt 5 ]; do echo tick$i; i=$((i+1)); sleep 0.1; done")` → polls with advancing offsets deliver each byte exactly once; final poll `status: 'done'`, `exitCode: 0`.
2. Non-zero exit is `done` + `exitCode`, not `failed`.
3. `cancelJob` mid-run → subsequent poll terminal with non-zero exit.
4. Unknown execId poll → `status: 'failed'`.
5. Bash tool (virtual/fake sandbox with spy-able job methods): `timeout: 120` (> threshold when test overrides threshold via injected opts — instead: use a fake sandbox and assert against the REAL 60s threshold by passing `timeout: 61` vs `timeout: 59`) → 61 selects job path, 59 selects sync path.
6. Bash tool job path accumulates output across polls into the final `{ text }`; deadline exceeded → cancel + `[exit …]`/timeout note in text; `ctx.signal` abort → `cancelJob` called.
7. Poll rejection (fake sandbox pollJob throws `SandboxUnavailableError`) → tool rejects with that error (propagates; no swallow).

- [ ] **Step 1:** Failing provider tests (local), then implement local + docker job mode (docker covered by conformance in Task 5 to avoid daemon-dependence here).
- [ ] **Step 2:** Failing bash-tool tests, then implement param + selection loop.
- [ ] **Step 3:** Wrapper job-op coverage: add 2 cases to the Task-2 suite (job op awaits readiness; poll failure degrades + reprovisions).
- [ ] **Step 4:** Green (engine + sandbox-local) + typecheck. Commit — `feat(sandbox): job-mode exec with offset polling; bash tool selects job mode past 60s`.

---

### Task 5: Sandbox provider conformance suite (virtual + local + docker)

**Files:**
- Create: `packages/engine/src/test-helpers/sandbox-contract.ts` (+ export from `test-helpers/index.ts`)
- Test: `packages/engine/test/virtual-sandbox-contract.test.ts`, `packages/sandbox-local/test/sandbox-contract.test.ts`, `packages/sandbox-docker/test/sandbox-contract.test.ts` (docker-gated per decision 11)
- Modify (only if the suite finds real deviations): the three providers — fix the provider, never weaken the suite.

**Suite cases (decision 11, each its own `it`):** utf8 + binary write/read round-trip; readdir lists created entries; stat file vs dir vs size; mkdir nested; rm recursive; exec stdout/stderr/exitCode separation; exec cwd override; exec per-request env injection (`FOO=bar` visible, absent on next exec); timeout forwarding (`sleep 5` with `timeout: 200` returns < 2s with `timedOut: true`); maxOutputBytes truncation (`truncated: true`, length ≤ limit); abort best-effort (flag-gated); job create/poll/cancel + offset-exactly-once; workspace survival: for `persistentWorkspace` providers, write file → `provider.destroy(id)` → `provider.create` same workspace → file still readable. Virtual runs a reduced set via flags (`supportsAbort: false`, exec cases limited to its command subset — the suite takes a `shell: 'full' | 'virtual'` flag choosing command fixtures).

- [ ] **Step 1:** Write the suite + the three harness files; watch virtual/local fail on genuine gaps; fix providers.
- [ ] **Step 2:** Run docker harness locally (Rancher Desktop running): `pnpm --filter @valet/sandbox-docker test`. Fix docker deviations (expect: timeout/maxOutput fine; env-per-exec passes via `--env`; job mode from Task 4).
- [ ] **Step 3:** Verify the docker suite SKIPS cleanly with the daemon stopped (or `VALET_SKIP_DOCKER_TESTS=1` escape hatch honored by `dockerAvailable()`).
- [ ] **Step 4:** Green everywhere + typecheck. Commit — `test(sandbox): provider conformance suite over virtual/local/docker`.

---

### Task 6: Fenced EventStream appends (Phase-2 carried item)

**Files:**
- Modify: `packages/engine/src/types.ts` (`EventStream.append(event, eventKey, fence?)`)
- Modify: `packages/engine/src/providers/in-memory/event-stream.ts` (+ `fenceCheck` opt), `packages/engine/src/providers/in-memory/store.ts` (`isCurrentAttempt`)
- Modify: `packages/store-sqlite/src/event-stream.ts` (in-transaction attempt check)
- Modify: `packages/engine/src/session.ts` (`EmitOptions.fence`, rethrow `StaleAttemptError`), `packages/engine/src/thread.ts` (pass turn fence on live-execution emissions per decision 12)
- Modify: `packages/engine/src/test-helpers/event-stream-contract.ts` (fence cases; suite ctx gains an optional fence fixture)
- Test: existing `in-memory-event-stream.test.ts` / `store-sqlite` stream test wire the fixture; `packages/engine/test/fenced-emit.test.ts`

**Interfaces:** decision 12 verbatim. Contract-suite fixture: `ctx.fenceFixture?: { seed: (itemId: string, attemptId: string) => Promise<void> }` — seeds a submission whose current attempt is `attemptId` so the suite can exercise valid vs stale fences on both backends (in-memory seeds via `InMemoryStore`; sqlite via a real admitted+claimed row using existing store methods).

**Test plan:**
1. Contract: append with a fence naming the current attempt succeeds; with a stale attemptId rejects `StaleAttemptError`; nothing appended (read unchanged); fence-less append still works.
2. Sqlite parity via the same suite.
3. Engine-level zombie double-emit: drive a turn to claimed state, replace the attempt via the store (simulating reclaim), then `session.emit({type:'status',…}, { fence: oldFence })` → rejects StaleAttemptError; durable log contains no event from the old attempt.
4. Live-execution events in a normal turn still land (happy-path suite green proves fence-passing didn't break emission).

- [ ] **Step 1:** Failing contract cases → implement both stream backends.
- [ ] **Step 2:** Failing fenced-emit engine test → wire `EmitOptions.fence` + thread call sites (all `handleAgentEvent` emissions + `turn_end`/`status` inside claimed turns; settlement/gate emissions untouched).
- [ ] **Step 3:** Full engine + store-sqlite suites green + typecheck.
- [ ] **Step 4:** Commit — `feat(engine): attempt-fenced EventStream appends close the zombie double-emit gap`.
- [ ] **Step 5:** Update the spec's §1198 bracketed implementation-status note (fencing now implemented) in the same commit or a follow-up `docs:` commit.

---

### Task 7: Wire + web — sandbox.status ambient indicator

**Files:**
- Modify: `packages/api/src/wire/types.ts` (WireEvent `sandbox.status` per decision 13)
- Modify: `packages/api/src/engine/bridge.ts` (map `sandbox_status`)
- Modify: `packages/api/src/engine/host.ts` (pass provider capabilities' `defaultImage` unchanged; nothing else expected — verify compile)
- Modify: `packages/web/src/stores/stream.ts` (`sandbox` slice + reducer case)
- Modify: `packages/web/src/components/session/session-header.tsx` (ambient chip)
- Test: `packages/api/test` bridge unit test (if bridge tests exist, extend; else add `packages/api/src/engine/bridge.test.ts` case), `packages/web/src/stores/stream.test.ts` reducer case

**Test plan:** bridge maps an engine `sandbox_status` BusEvent to `{ type: "sandbox.status", state, epoch, estimateMs }` with offset passthrough; web store updates `sandbox` on the event and ignores stale-epoch regressions (an event with epoch < current is dropped — replay-safety); header renders chip states (existing component-test idiom if any; otherwise store-level test only + visual check in dogfood).

- [ ] **Step 1:** Failing bridge + store tests → implement.
- [ ] **Step 2:** Chip in `SessionHeader` (dot + label, colors: provisioning amber, ready green, error red; hidden when no data).
- [ ] **Step 3:** `pnpm --filter @valet/api test`, `pnpm --filter @valet/web test`, typecheck. Commit — `feat(api,web): sandbox.status wire event + ambient workspace chip`.

---

### Task 8: Exit-criteria E2E — kill container mid-exec, long exec, cold-start dogfood

**Files:**
- Test: `packages/sandbox-docker/test/kill-container-recovery.test.ts` (docker-gated)
- Test: `packages/engine/test/long-exec-job-mode.test.ts` (local provider, real ~65s+ boundary avoided: use bash `timeout: 61` with a 3s command — job path exercised without wall-clock pain; plus ONE docker-gated 3-minute case `sleep 180 && echo done` behind `VALET_LONG_TESTS=1`)
- Modify: `.superpowers/sdd/progress.md` (dogfood checklist appended)

**Test plan:**
1. **Kill-container-mid-exec (docker-gated):** engine session over `DockerSandboxProvider` + PolicySandbox, scripted model runs `bash` `sleep 30`; test `docker rm -f`s the container after the exec starts → tool result is an error containing `[sandbox_unavailable]`; submission settles via normal turn logic (NOT `failed`-by-engine); attachment re-provisions (status events show epoch 2 ready); a follow-up prompt's `bash echo recovered` succeeds. Asserts decision 14 end-to-end.
2. **Long exec via job mode:** as above in Files; assert output completeness and `execJob` path taken.
3. **Cold-start first-tokens:** already covered at unit level (Task 3 test 1); add one docker-gated variant: fresh session, prompt with a no-tool scripted model, assert first durable `message_start` timestamp < attachment-ready timestamp.
4. Full repo gates: `pnpm --filter @valet/engine test`, `pnpm --filter @valet/store-sqlite test`, `pnpm --filter @valet/api test`, `pnpm --filter @valet/web test`, `pnpm typecheck` (known sanctioned failure: `packages/worker/src/integrations/packages.ts`).

- [ ] **Step 1:** Write + green the three suites.
- [ ] **Step 2:** Commit — `test(engine,sandbox-docker): phase 3 exit criteria — kill-container recovery, job-mode long exec, cold-start tokens`.
- [ ] **Step 3 (coordinator, manual dogfood):** `make dev-local`; new session; prompt immediately → tokens stream before `docker ps` shows the container; run a >60s command via chat (`sleep 90 && echo done`) → completes; `docker rm -f` the session container mid-command → chat shows a structured tool error, workspace chip flips provisioning→ready, retry succeeds. Record in ledger.

---

## Exit Criteria (phase gate)

- A session prompt gets first tokens before the container is running (Task 3 test 1 + Task 8.3 + dogfood).
- A 3-minute `sleep && echo` exec completes via job mode (Task 8.2 gated long case + dogfood 90s variant).
- Killing the container mid-exec produces a structured retryable tool error and a background re-provision, never a session error (Task 8.1 + dogfood).
- Sandbox provider conformance suite green on virtual + local + docker (Task 5).
- Fenced EventStream appends: zombie attempt's live-execution append is refused (Task 6).
- All prior suites (engine 230+, store-sqlite 73+, api 27+, web 8+) green.
