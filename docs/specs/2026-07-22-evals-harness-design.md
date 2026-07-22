# Engine Traces + Evals Harness Design

**Date:** 2026-07-22
**Status:** Proposal
**Scope:** Two coupled deliverables.

**Part 1 — Engine traces** as a first-class artifact serving BOTH consumers: observability (live/ops) AND evaluations (post-hoc verification of performance + cost). Per-turn tokens/cost/timing become durable fields on the transcript; the existing `engine_events` and `engine_entries` planes are what surface them.

**Part 2 — Evals harness** wrapping `@valet/engine` as a library. Runs an eval task through EITHER an orchestrator session (arbitrary session nesting, per-child model + params + sandbox-mode selection) OR a flat single-session, so the two topologies can be compared as experiment arms on the same task set. Similar in shape to DeepSWE + mini-swe-agent: uniform wrapper, swap the model per run, cheap to re-run when the next frontier model drops.

## 1. Motivation

V2's core thesis is *"the engine is a library, not a distributed system."* Model choice is per-session (`packages/engine/src/types.ts:1149`), the host `resolveModel` seam (`types.ts:1173`) makes provider swaps trivial, and `ChildSpawner` + the `task` built-in tool (`packages/engine/src/builtin-tools/index.ts:359-403`) makes session↔session nesting first-class. But we can't yet answer the two questions that make model-agnosticism actually valuable:

1. **How much did this session cost, and where did the time go?** Per-turn usage is captured live from `turn_end` events into a private in-memory field on Thread (`thread.ts:186-189, 2756-2769`), used only to threshold compaction (`thread.ts:2115`), then **discarded**. `MessageEntry` (`types.ts:272-297`) has `model?` but no `usage` / `cost`. `engine_entries` (`packages/store-postgres/migrations/pg/0000_engine.sql`) matches. The durable `turn_end` event payload is `{ threadId, reason }` — no usage. There is no queryable, per-turn record of what a session cost, how many turns it took, or which tool calls ran with what args and results. **This blocks both o11y and evals.**
2. **Does model A beat model B on our real workloads, alone or in a planner/executor split?** No dev tooling exists. Grep for `eval|benchmark|golden|scenario|verifier` returns only git-credential goldens and plugin validators — nothing model-comparison shaped.

Three forces make solving both worth it now:

- **Model churn (Xiangan, 2026-07):** *"the top-performing models change all the time, there's not really a 'true winner' in the model wars."* Frontier models drop every 2–4 weeks; single-benchmark results decay fast. The harness has to be cheap to re-run — traces have to be dense enough to be worth re-running against.
- **Cost-vs-quality (Xiangan's Fable / gpt-5.6 pattern):** *"a Claude/Fable agent should be able to spawn gpt5.6 sol subagents"* — plan with the expensive model, execute with the cheap/fast one. Nothing measures whether the split beats the single-model baseline. That measurement is exactly `Σ(cost) + Σ(quality)` over a task set — trace + verifier stack.
- **Composability payoff (Conner):** *"the v2 engine is very composable in terms of session↔session nesting so we really just need to program the logic that pings model-sessions against one-another + a trace to evaluate it."* Primitives exist; the delta is traces + harness glue + a few sharp engine changes to make nested experimentation expressive.

**Prior art:**
- **DeepSWE** (https://deepswe.datacurve.ai/): contamination-free tasks, **behavioral verifiers** (not implementation-detail matching), plots cost / output tokens / agent-steps per model. Same axes we want.
- **mini-swe-agent:** one uniform wrapper, swap the model.
- **`docs/specs/2026-07-16-usage-telemetry-design.md`** (Draft): proposes a new `turn_usage` engine event + `telemetry_events` projection + four admin tabs. **Part 1 of this spec supersedes that spec's Decision 1** with a strictly larger change (usage on the *entry*, not just an ephemeral event) — the projection and tabs downstream stay valid and consume the same source. Coordinate with that spec's author.
- **Ramp's internal model router** (launched 2026-07): downstream of eval data. Explicitly out of scope — the harness produces the data a router would consume.

## 2. Non-goals

- **Not a model router.** Downstream of eval data (Ramp's territory).
- **Not a general LLM benchmark.** Tasks are Valet-shaped (session prompt → engine loop → structured/behavioral outcome).
- **Not a first-class "eval" workflow construct.** `packages/workflow` is not the right home; evals are dev tooling.
- **Not multi-turn user simulation.** Each task is one prompt → one settled submission (which may internally spawn any number of nested sessions).
- **Not the full org-admin tabs.** `2026-07-16-usage-telemetry-design.md`'s Usage / Performance / Events / Value UIs are downstream of traces landing; this spec doesn't ship them.
- **Not a new tracing wire format.** No OTel exporter, no separate spans table. Traces are assembled from `engine_entries` + `engine_events` — the two planes that already exist. (An OTel exporter is a plausible future consumer, out of scope here; see §7.4.)

---

## Part 1 — Engine traces

### 3. What a trace is

A **trace** is the durable record of what happened during a run, structured as a tree because a run can spawn nested runs.

- **Run:** the execution of one submission (one `queueItemId` on one thread). A user prompt is a run; a `task`-tool spawn from an orchestrator turn is a child run.
- **Step:** one assistant turn within a run — model call, tool calls, tokens spent. A run has `1..N` steps.
- **Trace:** the tree rooted at a run — root run + child runs (recursive).

Two consumers, one source:

| Consumer | Access pattern |
|---|---|
| **Observability** (live ops, per-org usage dashboards, per-session token/cost display) | Bus subscribe on `turn_end` for live; SQL over `engine_entries` for post-hoc rollups |
| **Evals** (harness scores runs on correctness + cost) | Harness calls `assembleTrace(store, sessionId, queueItemId)` after `awaitResult`; reads `.totalCost` / `.totalTurns` / `.steps` |

### 4. What we need on each step

Fields, and whether they exist today:

| Field | Source | Persisted today? |
|---|---|---|
| `sessionId` | `Session.id` | ✅ `engine_entries.session_id` |
| `threadId` | `Thread.id` | ✅ `engine_entries.thread_id` |
| `queueItemId` | claimed queue item | ✅ `engine_entries.queue_item_id` |
| `entryId` | assistant `MessageEntry.id` | ✅ PK |
| `parentSessionId` | `Session.parentSessionId` (`session.ts:98`) | ✅ `engine_sessions.parent_session_id` |
| `model` | resolved model id at turn start | ✅ `MessageEntry.model` (types.ts:279) |
| `stopReason` | end_turn / error / abort | ✅ `MessageEntry.stopReason` (types.ts:281) |
| `toolCalls[]` | assistant `MessageEntry.parts` where `type: 'tool_call'` | ✅ `parts` JSON (types.ts:256-269) |
| `usage.input` | `event.message.usage.input` (`thread.ts:2762-2769`) | ❌ **dropped after compaction check** |
| `usage.output` | same | ❌ |
| `usage.cacheRead` | same | ❌ |
| `usage.cacheWrite` | same | ❌ |
| `usage.total` | same | ❌ |
| `cost.{input,output,cacheRead,cacheWrite,total}` | pi-ai per-model pricing × usage (available on `Model<any>`, see `thread.ts:3237` shape) | ❌ |
| `turnDurationMs` | `turn_end.timestamp − message_start.timestamp` | derivable from events, not stamped |

Everything unchecked is the gap. Turns out ALL of it is derivable at the single site where `lastAssistantUsage` is already captured — we just don't persist it. The design is: add the fields to the canonical row that already exists (the assistant `MessageEntry`), not a sibling table.

### 5. Proposed engine change (Part 1)

#### 5.1 Widen `MessageEntry`

```ts
// packages/engine/src/types.ts:272-297 — add two optional fields
export interface MessageEntry extends BaseEntry {
  type: "message";
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  parts?: MessagePart[];
  // ...existing fields...
  model?: string;
  stopReason?: "end_turn" | "error" | "abort";
  // NEW — populated only for assistant entries whose turn recorded usage:
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  turnDurationMs?: number;
}
```

Rationale for landing on `MessageEntry` rather than a sibling `turn_usage` table:
- The final assistant entry already exists per turn and already carries `model` + `stopReason`. Adding usage keeps trace assembly = "read entries" instead of "read entries JOIN usage".
- `queueItemId` is already indexed on `engine_entries` (`engine_entries_queue_item`) — cost-per-run queries fall out of the same index.
- Compaction already stores `token_count_before/after` on `CompactionEntry` (`types.ts:299-306`) — token accounting on entries is an established pattern.

#### 5.2 Migration

```sql
-- packages/store-postgres/migrations/pg/000X_engine_entries_usage.sql
ALTER TABLE engine_entries ADD COLUMN usage jsonb;             -- {input, output, cacheRead, cacheWrite, total}
ALTER TABLE engine_entries ADD COLUMN cost  jsonb;             -- same shape, USD
ALTER TABLE engine_entries ADD COLUMN turn_duration_ms integer;
```

All nullable — old entries and non-assistant entries stay NULL. JSONB (rather than 10 flat columns) keeps the migration narrow; per-field aggregation is the telemetry-projection subscriber's job (§7.1), not this table's.

#### 5.3 Capture site (already handles usage)

`thread.ts:2756-2769` — the `turn_end` handler where `lastAssistantUsage` is populated. Extend the same site to:
1. Compute `cost` from pi-ai's model pricing (already available on the `Model<any>` — see the shape at `thread.ts:3237`).
2. Stamp `usage` / `cost` / `turnDurationMs` onto the final assistant `MessageEntry` before it's persisted (via `store.appendEntries`, or `store.updateEntry` if it's already written — check the code path).
3. Continue populating `lastAssistantUsage` for compaction (unchanged).

One existing site touched, no new emitters, small isolated change.

#### 5.4 Widen `turn_end` on the bus

Extend the `turn_end` variant of `EngineEvent` (`types.ts:749`) from `{ type: 'turn_end'; threadId; reason }` to also carry `{ model?; usage?; cost?; turnDurationMs?; queueItemId? }`. The `payload` column on `engine_events` is stringified `EngineEvent` — widening the union widens the durable row automatically.

Trade-off vs. a new `turn_usage` event (the shape `2026-07-16-usage-telemetry-design.md` Decision 1 proposes): one fewer event type; subscribers that don't care about usage still deserialize the extra fields (cheap). Recommend widen; if that spec's author prefers a separate event, this spec's §5.1 (widen entry) is orthogonal to the event choice — the entry write is what matters for both consumers.

### 6. Trace assembly

A new engine helper — pure over `SessionStore`, no cross-package deps:

```ts
// packages/engine/src/tracing.ts (new)
export interface TraceStep {
  entryId: string;
  turnIndex: number;                          // 0-based within the run
  model: string;
  usage: TokenUsage;
  cost: MoneyUsage;
  turnDurationMs: number;
  stopReason: "end_turn" | "error" | "abort";
  toolCalls: Array<{ callId: string; toolName: string; args: unknown; result?: unknown; error?: string; isError: boolean }>;
}

export interface Trace {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  outcome: SubmissionOutcome;
  steps: TraceStep[];
  children: Trace[];                          // recursively; one per spawned child
  totalUsage: TokenUsage;                     // sum of steps + children
  totalCost: MoneyUsage;
  totalTurns: number;
  wallClockMs: number;
}

export function assembleTrace(
  store: SessionStore,
  sessionId: string,
  queueItemId: string,
  opts?: {
    // Returns child (sessionId, queueItemId) pairs to recurse on. Engine-layer
    // helper doesn't know about api's child_watches table; caller wires it.
    resolveChildren?: (parent: { sessionId: string; queueItemId: string }) =>
      Promise<Array<{ sessionId: string; queueItemId: string }>>;
  },
): Promise<Trace>;
```

Child inclusion is a callback so the engine stays store-only. The api wires the api-side `child_watches` lookup (`packages/api/src/orchestrator/children.ts:158-171`); the harness wires its own child bookkeeping (§10.3).

### 7. Relationship to the two consumers, and to existing infra

#### 7.1 Observability path

- **Live:** `providers.stream.subscribe({ eventTypes: ["turn_end"] }, cb)` — subscriber receives every turn's usage/cost as it lands.
- **Post-hoc rollups (per-org dashboards, per-session view):** SQL over `engine_entries` filtered by `session_id` / `queue_item_id` / `created_at`.
- **Projection** (the pattern `2026-07-16-usage-telemetry-design.md` Decision 2 proposes): global subscriber projects `turn_end` into flat `telemetry_events` rows for retention beyond the engine log's 7-day submission-prune window. Independent of this spec; consumes the same source.

#### 7.2 Evals path

- Harness calls `assembleTrace(store, sessionId, queueItemId)` right after `awaitResult` returns.
- `resolveChildren` is wired to the harness's own child bookkeeping (§10.3).
- Verifier receives `(SubmissionResult, Trace)`; scorer aggregates `trace.totalCost`, `trace.totalTurns`, etc. across the task set.

#### 7.3 Relationship to OpenTelemetry

There is **no OTel** on dev-v2 today (confirmed: no `@opentelemetry/*` in any `package.json`, no `tracer`/`Span` primitives in `packages/engine` or `packages/api`, no OTel-shaped exporter). `docs/specs/2026-04-15-grafana-cloud-integration-design.md` is a *user-tool* for querying customer Grafana instances — not self-observability. The only tracing-adjacent draft is `2026-07-16-usage-telemetry-design.md`, which uses the engine's own event bus + a projection table (no OTel).

We are therefore not "replacing OTel" or "feeding OTel" — there is nothing to replace or feed. The design intentionally sits on the engine's existing durable-event + entry planes because they're what the codebase has. **An OTel exporter over the trace structure is a plausible future** (subscribe to `turn_end`, emit as spans keyed by `sessionId`/`queueItemId`; nested traces map to child spans) but explicitly out of scope for this spec.

#### 7.4 Relationship to `docs/specs/2026-07-16-usage-telemetry-design.md`

That spec has one engine change (`turn_usage` event) + one big projection + four org-admin tabs. This spec:
- **Replaces its Decision 1** with a strictly larger change (usage on the *entry*, not just on the bus).
- **Leaves Decisions 2–7 intact.** The projection subscriber consumes `turn_end` (now widened) directly; the four tabs are unchanged.

Recommend: loop in that spec's author on Part 1 review. If they'd rather ship `turn_usage` separately, this spec's §5.1 (widen entry) is independent of the event choice.

---

## Part 2 — Evals harness

### 8. Engine primitives the harness leans on

All grounded, `path:line` verified on `dev-v2`.

- **Engine + Session as a library.** `Engine.createSession/restoreSession/getSession/deleteSession` (`engine.ts:26-71`). Canonical headless-run wiring at `packages/engine/bin/repl.ts:105-207`.
- **Per-session model.** `CreateSessionOptions.model: Model<any>` required (`types.ts:1149`). Layered per-turn resolution: `thread.modelOverride → session.options.model → hostDefault` (`thread.ts:1045-1080`).
- **Host `resolveModel` seam.** `(spec) => Promise<ResolvedModel | null>` returns `{ model, apiKey? }` per turn (`types.ts:1132, 1173`); `apiKey` held per-turn only, cleared at turn end (`thread.ts:207-213`).
- **Structured output.** `AwaitResultOptions.resultSchema` (`types.ts:171`) → `extractStructuredOutput` (`result-schema.ts`) → `SubmissionResult.output`/`error` (`thread.ts:2897-2926`).
- **`awaitResult`** (`thread.ts:2868`) — durable-poll fallback under the covers; `submission_settled` events as wakeups.
- **Idempotent admission** via `PromptOptions.dispatchId` (`types.ts:222`) — reruns don't duplicate.
- **Session nesting.** `ChildSpawner` type (`types.ts:1338`), `task` built-in (`builtin-tools/index.ts:359-403`), engine gates purely on `typeof ctx.config?.childSpawner === "function"` (line 379-383).

### 9. Two run topologies as first-class experiment arms

Conner's requirement: the harness must evaluate BOTH topologies as comparable experiment arms on the same task.

#### 9.1 Flat mode

One session, `purpose: 'interactive'`, no `childSpawner` in `toolConfig`. The `task` tool returns `[task_unavailable]` (`builtin-tools/index.ts:381`) if invoked. Single trace, single model — or a role-based single-trace split via `RoleSpec.model` (`types.ts:1105`) + the `switch_model` built-in.

Trace is a single-node tree (`Trace.children = []`).

#### 9.2 Orchestrator mode

One session, `purpose: 'orchestrator'`, harness-controlled `childSpawner` injected into `toolConfig`. The harness spawner:
- forces per-child `model`,
- can override `systemPrompt` / `tools` / `roles` / `sandbox` per child (subject to §11.1 — `SpawnChildRequest` doesn't carry these today),
- picks `sandbox-mode` per child (§10.2).

Trace is a tree — parent run + one child sub-trace per spawn.

#### 9.3 What actually distinguishes "orchestrator" from "normal"

Not a runtime capability check inside the engine. Purely a **host convention** at the api layer:

- `EngineHost.orchestratorSessionFor` (`packages/api/src/engine/host.ts:749-811`) — the ONLY code path that injects `toolConfig.childSpawner` (line 793-797). Also sets `purpose: 'orchestrator'` (782), `queueMode: principal.type === 'user' ? 'steer' : 'followup'` (771), `warmSandboxOnClaim: false` (810 — sandbox-less by default until a tool touches the fs).
- `EngineHost.buildSession` (interactive user sessions, host.ts:440-511), `EngineHost.childSessionFor` (host.ts:1195-1276), `EngineHost.workflowSessionFor` (host.ts:1288+) all **deliberately omit** `childSpawner`. Doc string at host.ts:1191-1194: *"children can't spawn grandchildren."*
- Well-known session id `orchestrator:{type}:{id}` (`principal.ts:41-50`); `sessionFor` dispatches to `orchestratorSessionFor` when the id parses (host.ts:423-426).

**The harness controls `toolConfig` directly** — it decides mode by injecting or omitting `childSpawner`. No need to mimic api-host wiring; both modes are the harness's own construction.

### 10. Session-nesting requirements for experimentation

Conner's explicit requirements + what dev-v2 supports today.

#### 10.1 Parent selects child's model + params

Child session parameters the harness needs to control per-spawn:
- `model` — for the multi-model experimentation core.
- `systemPrompt` — child gets a different role's system prompt (e.g. reviewer vs implementer).
- `tools` — child gets a scoped tool set (e.g. reviewer gets read-only tools).
- `roles`, `skills` — same.
- `sandbox` mode (§10.2).

**Current SpawnChildRequest** (`types.ts:1319-1325`):

```ts
export interface SpawnChildRequest {
  prompt: string;
  title?: string;
  repo?: string;
  branch?: string;
  model?: string;
}
```

**Gap.** `SpawnChildRequest` is only expressive enough for "spawn a child with a different prompt + model + repo binding." For parent=implementer/child=reviewer experiments driven by the LLM via the `task` tool, we need at least: `systemPrompt?`, `tools?` (allowlist by name), `roles?` (name references, not full specs), and — for §10.2 — `sandboxMode?`.

Two paths:
1. **Extend `SpawnChildRequest`** (proposed engine change §12.2) — the LLM's `task` tool then accepts richer params. Requires care: the tool's parameter schema (`builtin-tools/index.ts:367-373`) is what the LLM sees; adding params balloons the prompt surface and gives the LLM more foot-guns.
2. **Harness bypasses the `task` tool** and drives its own `ChildSpawner` API directly from harness code (not from LLM tool calls). The parent's system prompt tells the LLM what child spawns look like conceptually, but the actual spawn is harness-orchestrated based on the parent's structured output. Cleaner for structured experimentation but doesn't match the "LLM chooses when to spawn" pattern.

Recommend: **both.** Extend `SpawnChildRequest` minimally (add `systemPrompt?`, `tools?`, `sandboxMode?`) for LLM-driven spawns; also expose the harness `ChildSpawner` directly for structured multi-arm experiments where the harness decides the topology, not the LLM.

#### 10.2 Sandbox: shared volume vs isolated

Restated requirement: children must be able to EITHER share the parent sandbox volume OR get their own. Answer depends heavily on the sandbox provider:

| Mode | Docker | Local | Kubernetes | Virtual |
|---|---|---|---|---|
| **A. Isolated** (child gets fresh workspace path, own container/pod/PVC) | ✅ default (`children.ts:144`) | ✅ default | ✅ default | ✅ default |
| **B. Shared volume, separate containers** (both bind the same host dir) | ✅ pass same `workspace` string — Docker binds host dir at `/workspace` twice (`sandbox-docker/src/sandbox.ts:162-163`, `CONTAINER_WORKSPACE = "/workspace"` at :132) | ✅ same `workspace` → same host dir; local sandbox has **NO isolation at all** (documented at `sandbox-local/src/sandbox.ts:34`) | ⚠️ **BLOCKED by default.** PVC is `accessModes: ["ReadWriteOnce"]` (`sandbox-kubernetes/src/manifest.ts:151`), so a second pod can't mount the same PVC RW. Would need RWX storage class or ROX for read-only children. | ❌ ignores `opts.workspace` entirely (`virtual.ts:251-256`) — every VirtualSandbox is an isolated in-mem fs |
| **C. Shared sandbox handle** (child gets parent's live `Sandbox` object) | ✅ via `SandboxAttachment.forSandbox(parent.sandbox)` (`engine.ts:88-92`, `attachment.ts` `forSandbox`) | ✅ same | ✅ same, or naturally via same `workspace` → same CR name (`sandbox-kubernetes/src/manifest.ts:77-79`, `sandboxCrName = deterministicRfc1123(sessionKey)`) + upsert-shaped create adopting existing CR | ✅ same handle → same in-mem fs |

**Concrete mechanics:**

- **Mode A (isolated), all providers:** `sandbox: { workspace: freshPath }` — `SandboxCreateOpts.workspace` (`types.ts:626`) mints a new sandbox on first tool-touch.
- **Mode B (shared volume), Docker/Local:** `sandbox: { workspace: parent.options.workspace }` — same string → same bind mount / same host dir. Docker gives you two containers each mounting the same host dir at `/workspace`; concurrent writes are the caller's problem (unresolved race question, §14.3).
- **Mode B on k8s:** **requires the storage class to support `ReadWriteMany`**. Rancher Desktop's `local-path` provisioner (which `2026-07-15-kubernetes-deployment-design.md` Decision 1 pins) is RWO-only. Options: (a) file a follow-up for RWX support in the k8s provider (change `accessModes` on the PVC template + document storage-class requirement); (b) treat mode B as docker/local-only for the harness MVP; (c) fall back to mode C on k8s. Recommend (b) + (c) for the MVP.
- **Mode C (shared handle):** `sandbox: parent.sandbox` — `CreateSessionOptions.sandbox: Sandbox | SandboxCreateOpts` (`types.ts:1145`), the concrete-`Sandbox` branch calls `SandboxAttachment.forSandbox(sandbox)` (`engine.ts:88-92`). Both sessions drive the same live container/pod, same fs, same exec context.

  **Footgun** (real, verified): `SandboxAttachment.destroy()` (`attachment.ts:317-337`) calls `sandbox.destroy()` on the shared handle when the child session is destroyed. That would kill the parent's sandbox too. Mitigations:
  - **Harness discipline:** never call `engine.deleteSession(childId)` on shared-sandbox children; let the parent's teardown handle it.
  - **Or:** new engine helper `SandboxAttachment.forSharedSandbox(sandbox)` variant that skips the `sandbox.destroy()` call on `attachment.destroy()`. Small, additive engine change (§12.3).

#### 10.3 Result flow

`ChildWatcher` pattern already exists in the api layer (`packages/api/src/orchestrator/children.ts:277-410`) and is exactly what the harness needs:
- Await `child.thread().awaitResult(queueItemId)`.
- Admit `child.settled` signal into parent's thread with `dispatchId: settled:{childSessionId}:{queueItemId}` (deterministic → idempotent → restart-safe).
- Mark child watch settled.

The harness ships its own thinner variant (no db, no per-org limits, no drop-log — that's api concern). See §13.1.

### 11. Task format + core loop

#### 11.1 Task file

Markdown-with-frontmatter, matching `roles-skills/parser.ts` convention:

```markdown
---
id: task-042
title: Fix the auth regression
tags: [swe-bench-like, high-difficulty]
timeoutMs: 300000
sandbox: docker                              # virtual | docker | local
tools: [read, write, edit, bash, thread_read]
resultSchema:                                # optional typebox schema
  type: object
  required: [patch]
  properties: { patch: { type: string } }
verifier: verifiers/task-042.ts              # optional behavioral verifier
---

# Prompt

<full task text>
```

#### 11.2 Run configuration

```ts
export interface RunConfig {
  topology: 'flat' | 'orchestrator';
  parentModel: string;                        // e.g. 'anthropic/claude-opus-4-7'

  // orchestrator-only:
  childModel?: string;                        // e.g. 'openai/gpt-5.6'
  childSandboxMode?: 'isolated' | 'shared-volume' | 'shared-sandbox';
  splitPattern?: 'planner-executor' | 'implementer-reviewer' | 'inverse';
  childSystemPromptOverride?: string;         // per §10.1 requires SpawnChildRequest extension
  childToolAllowlist?: string[];              // same
}
```

Run the same task under multiple configs to compare arms: `{ flat, opus }`, `{ flat, gpt5.6 }`, `{ orchestrator, opus, gpt5.6, planner-executor, isolated }`, etc.

#### 11.3 Core loop

```ts
// packages/evals/src/harness.ts (sketch)
export async function runTask(
  task: Task,
  cfg: RunConfig,
  deps: { providers: ProviderBundle; sandboxProvider?: SandboxProvider; runId: string },
): Promise<TaskResult> {
  const engine = new Engine({ providers: deps.providers });
  const sessionId = `eval-${deps.runId}-${task.id}-${slug(cfg)}`;

  const session = cfg.topology === 'orchestrator'
    ? await buildOrchestratorSession(engine, sessionId, task, cfg)   // §13
    : await buildFlatSession(engine, sessionId, task, cfg);

  const receipt = await session.prompt(task.prompt, {
    dispatchId: `${sessionId}:main`,            // idempotent
    resultSchema: task.resultSchema,
    ...(cfg.topology === 'flat' && cfg.splitPattern ? { role: 'planner' } : {}),
  });

  const result = await session.thread().awaitResult(receipt.queueItemId, {
    timeoutMs: task.timeoutMs ?? 120_000,
    resultSchema: task.resultSchema,
  });

  const trace = await assembleTrace(deps.providers.store, sessionId, receipt.queueItemId, {
    resolveChildren: harnessResolveChildren(sessionId),  // §13.1
  });

  const score = task.verifier
    ? await task.verifier(result, trace)
    : defaultScore(result, task.resultSchema);

  await engine.deleteSession(sessionId);         // opt-out via --keep-sessions
  return { taskId: task.id, cfg, outcome: result.outcome,
           finalText: result.text, score, trace,
           sessionId, queueItemId: receipt.queueItemId };
}
```

#### 11.4 Scoring

- **Correctness** (per task):
  - `resultSchema`-based — cheap, deterministic, no LLM judge.
  - **Behavioral verifier** (DeepSWE-style) — hand-written TS module, given `(result, trace)`, returning `Score`. Preferred over string-matching. Examples: "did the child reviewer call `read` before responding," "does the final `write` produce a file that compiles," "did the planner emit a valid plan.md before spawning the executor."
- **Comparative axes** (per config, aggregated across the set), directly from `Trace`:

| Axis | Trace field |
|---|---|
| Success rate | fraction of `TaskResult.score.passed` |
| Cost per task ($) | `trace.totalCost.total` |
| Output tokens per task | `trace.totalUsage.output` |
| Agent steps (turns) | `trace.totalTurns` |
| Tool calls per task | recursive `sum(step.toolCalls.length)` |
| Wall-clock per task | `trace.wallClockMs` |
| Error rate | fraction with any `stopReason: 'error'` or `toolCalls[].isError` |

### 12. Harness placement + providers

New in-repo package: `packages/evals/`, `private: true`. Depends on `@valet/engine`, `@valet/store-postgres` (opt-in), `@mariozechner/pi-ai` (for `getModel` + `registerFauxProvider` in self-tests). Not published, not part of the CLI binary, not shipped in the api image. Recommend in-repo over a hypothetical `tkhq/test-agents-infra` external repo for the MVP; migrate later if the set grows past ~50 tasks. [uncertain: whether `tkhq/test-agents-infra` already exists.]

- **Store:** `InMemorySessionStore` for MVP (`packages/engine/src/providers/in-memory/`). Postgres opt-in for runs that want to persist traces between harness invocations. **Part 1's `usage`/`cost` fields land on `engine_entries`**, so opting into Postgres means opting into a queryable trace archive.
- **Event stream:** `InMemoryEventStream` for MVP; Postgres event stream when using Postgres store.
- **Sandbox:** picked per-task via frontmatter. Virtual for schema-only tasks, Docker for anything touching files. `LocalSandbox` discouraged for the harness (host-fs poisoning risk). Kubernetes provider not recommended for harness runs.

### 13. Harness's own child spawner + watcher

#### 13.1 Spawner (with sandbox-mode knob)

```ts
// packages/evals/src/session-modes.ts (sketch)
export function buildEvalChildSpawner(
  engine: Engine,
  parentSession: Session,
  cfg: RunConfig,
): ChildSpawner {
  return async (req, ctx) => {
    const childSessionId = `${parentSession.id}::child::${uid()}`;

    let sandbox: Sandbox | SandboxCreateOpts;
    switch (cfg.childSandboxMode ?? 'isolated') {
      case 'isolated': {
        const workspace = join(EVAL_WORKSPACE_ROOT, childSessionId);
        await mkdir(workspace, { recursive: true });
        sandbox = { workspace };
        break;
      }
      case 'shared-volume':
        // Docker/Local only. On k8s this would need RWX PVC — flag/error.
        sandbox = { workspace: parentSession.options.workspace };
        break;
      case 'shared-sandbox':
        // Warning: destroy footgun (§10.2). Never call deleteSession on this child.
        sandbox = parentSession.sandbox;
        break;
    }

    const child = await engine.createSession({
      id: childSessionId,
      userId: 'evals', orgId: 'evals',
      workspace: typeof sandbox === 'object' && 'workspace' in sandbox
        ? sandbox.workspace : parentSession.options.workspace,
      sandbox,
      model: resolveModelById(cfg.childModel ?? req.model!),
      purpose: 'child',
      resolveModel: parentSession.options.resolveModel,
      parentSessionId: ctx.parentSessionId,
      parentThreadId: ctx.parentThreadId,
      owner: ctx.owner,
      systemPrompt: cfg.childSystemPromptOverride
                 ?? req.systemPrompt                    // requires §12.2 extension
                 ?? buildChildSystemPrompt(cfg),
      tools: filterTools(parentSession.options.tools, cfg.childToolAllowlist ?? req.tools),
      // No childSpawner in child's toolConfig — grandchildren blocked
      // unless cfg explicitly opts in.
    });

    const receipt = await child.prompt(req.prompt, {
      dispatchId: `${childSessionId}:main`,
    });

    // Record for trace assembly resolveChildren callback:
    recordChildWatch(parentSession.id, childSessionId, receipt.queueItemId);

    // Fire-and-forget watcher: awaits result, admits child.settled signal
    // to parent thread. Mirrors packages/api/src/orchestrator/children.ts:342-391.
    watchAndReportSettlement(child, parentSession, ctx, receipt.queueItemId);

    return { childSessionId, queueItemId: receipt.queueItemId };
  };
}
```

#### 13.2 In-memory child bookkeeping

Since the harness owns the run and lives one process, an in-memory map (`Map<parentSessionId, Array<{childSessionId, queueItemId}>>`) is enough for `assembleTrace`'s `resolveChildren` callback. No db, no restart survival needed (a crashed harness re-runs the eval from scratch — reruns are cheap by design).

### 14. Open questions

1. **`SpawnChildRequest` extension shape.** Add `systemPrompt?`, `tools?` (allowlist of tool names), `sandboxMode?`, `roles?` (name references, not full specs) — or subset? Every added field balloons the `task` tool's LLM-facing param schema (`builtin-tools/index.ts:367-373`). Recommend: extend only for the harness-visible spawn API, keep the `task` tool's public param schema narrow, let the harness bypass `task` for structured multi-arm experiments.

2. **Shared-volume on Kubernetes.** RWO PVC (`sandbox-kubernetes/src/manifest.ts:151`) blocks two-pods-one-volume. Options: extend the k8s provider with an optional `accessModes` override in `SandboxCreateOpts`; require RWX storage class in the deployment; or restrict shared-volume mode to Docker/Local for the MVP. Recommend the last.

3. **Shared-sandbox destroy footgun.** `SandboxAttachment.forSandbox(parent.sandbox)` + child `deleteSession` calls `sandbox.destroy()` on the parent's live handle (`attachment.ts:332-336`). Add `SandboxAttachment.forSharedSandbox` variant that skips destroy, or rely purely on harness discipline?

4. **Concurrency in shared-volume mode.** Parent and child pointing at the same host directory — race conditions on file writes are the caller's problem. Do we ship advisory locking (a `.lock` convention), or document it as caveat emptor and let the eval-set author manage sequencing via prompts?

5. **`turn_end` widen vs new `turn_usage` event.** §5.4 recommends widen; `2026-07-16-usage-telemetry-design.md` Decision 1 proposes a separate event. Coordinate.

6. **Which entry gets the usage row.** pi-agent-core emits `turn_end` per assistant message. Recommend: stamp `usage`/`cost` on every assistant `MessageEntry` (one row per turn) so tool-loop intermediate turns are individually costed. [uncertain: verify by tracing `thread.ts` runAgent loop — whether every assistant message gets its own `turn_end` or only the final one.]

7. **Faux-provider self-tests.** `registerFauxProvider` from `@mariozechner/pi-ai` (used throughout `packages/engine/test/`, e.g. `happy-path.test.ts:2`) is a canned-message provider. Harness self-tests should use it (`--faux` CLI flag) for deterministic scoring-layer coverage.

8. **Sandbox-mode default for orchestrator runs.** Recommend `isolated` (safest); `shared-volume` for SWE-bench-shaped tasks where the child needs to see parent's changes; `shared-sandbox` only for very short executor turns where concurrent-exec with parent is impossible.

9. **Where do results persist across harness runs?** MVP: JSON files under `packages/evals/results/{runId}/`. If cross-run diffing wanted later, new tables in `packages/api/src/schema/index.ts` (workflowRuns pattern). Not blocking.

10. **Contamination.** DeepSWE's cutoff-date framing is nontrivial to guarantee. For internal use we mostly don't care; if we ever publish a leaderboard: cutoff-date filter on tasks, no reuse of publicly-crawled sources.

11. **`tkhq/test-agents-infra` split.** In-repo vs external. Decide when the set grows past ~50 tasks.

12. **Model registry coverage.** pi-ai's `getModel` (`thread.ts:3113-3126`) determines which providers work zero-config. New frontier models drop before pi-ai supports them — pin a pi-ai version in `packages/evals`, or ship a shim.

### 15. Proposed engine changes, ranked by size

1. **`MessageEntry.usage/cost/turnDurationMs`** (§5.1) + migration (§5.2) + capture-site extension (§5.3) + `turn_end` widen (§5.4) + `assembleTrace` helper (§6). Small, isolated, unblocks BOTH consumers. **Do this first.**
2. **`SpawnChildRequest` extension** (§10.1, §14.1): add `systemPrompt?`, `tools?`, `sandboxMode?`. Minimal type changes; `task` tool's LLM-facing schema stays narrow if we route the new fields via a harness-only spawn API rather than the tool. Do this when the harness starts wanting expressive parent=implementer/child=reviewer runs.
3. **`SandboxAttachment.forSharedSandbox`** (§10.2, §14.3): new static variant that skips `sandbox.destroy()` on `attachment.destroy()`. Very small, additive. Do this when shared-sandbox mode graduates from "harness discipline works" to "harness+prod both need it."
4. **k8s provider RWX support** (§10.2, §14.2): `SandboxCreateOpts.accessModes?: string[]` override, plumbed into `sandbox-kubernetes/src/manifest.ts:148-155`. Larger — touches provider spec, storage-class docs, deploy chart. Only needed if shared-volume mode is required on k8s. Deferrable.

### 16. What this pass explicitly does not change

- No API routes.
- No `agent_sessions` / `child_watches` schema changes.
- No `packages/workflow` touchpoint.
- No router / model-selection logic.
- No admin UI (that's `2026-07-16-usage-telemetry-design.md`, consuming Part 1's trace source).
- No OTel exporter (plausible future consumer; out of scope here).
