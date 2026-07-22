# Evals Harness Design — model-swap test rig over `@valet/engine`

**Date:** 2026-07-22
**Status:** Proposal
**Scope:** A dev-only evals harness that consumes `@valet/engine` as a library and runs a fixed eval set against arbitrary models. Zero product surface, zero migrations, zero engine changes required. Similar in shape to DeepSWE + mini-swe-agent: one harness, uniform wrapper, swap the model per run. Enables cheap re-runs every time a new frontier model drops and side-by-side traces for planner/executor split experiments.

## 1. Motivation

The V2 engine's core thesis is *"the engine is a library, not a distributed system."* Model choice is per-session (`CreateSessionOptions.model`, `packages/engine/src/types.ts:1149`), and the host `resolveModel` seam (`types.ts:1173`) lets any caller swap providers at will. This model-agnosticism is under-utilized today: we have no way to answer "which model is best at what our agents actually do?" against a controlled task set.

Three forces make this worth building now:

1. **Model churn (Xiangan, 2026-07):** *"the top-performing models change all the time, there's not really a 'true winner' in the model wars."* A frontier model drops roughly every 2–4 weeks. The value of any single benchmark result decays fast; the harness has to be **cheap to re-run**, not perfect. Rerun-on-drop is the primary UX.

2. **Cost-vs-quality (Xiangan's Fable / gpt-5.6 pattern):** *"a Claude/Fable agent should be able to spawn gpt5.6 sol subagents"* — plan with the expensive model, execute with the cheap/fast one. The engine already supports this: `RoleSpec.model` (`types.ts:1105`) for a single-trace planner→executor within one thread; `ChildSpawner` + `task` tool (`builtin-tools/index.ts:359-403`) for nested planner-spawns-executor. We just have no infra to *measure* whether the split actually beats a single-model baseline on real tasks.

3. **Composability payoff (Conner):** *"the v2 engine is very composable in terms of session↔session nesting so we really just need to program the logic that pings model-sessions against one-another + a trace to evaluate it."* The primitives exist; the harness is glue.

**Prior art / adjacent:**
- **DeepSWE** (https://deepswe.datacurve.ai/): contamination-free tasks, **behavioral verifiers** (not implementation-detail matching), plots cost / output tokens / agent-steps per model. Same axes are the right ones for us.
- **mini-swe-agent:** uniform-wrapper pattern — one harness, one prompt scaffold, swap the model.
- **Ramp's internal model router** (launched 2026-07): the routing decision downstream of good eval data. Explicitly *out of scope* here — you can't route intelligently without measurement; the harness produces the measurement.

**What this is not:**
- Not an in-product feature. No routes, no UI, no DB migrations, no engine changes required for the MVP.
- Not a general LLM benchmark. Tasks are Valet-shaped (session prompt → engine loop → structured or behavioral outcome).
- Not a model router. The router is downstream of eval data.

## 2. Non-goals

- **In-product eval UI or dashboards.** Results are files / markdown reports for the MVP. If they later want a UI, that's a separate spec.
- **A first-class "eval" workflow construct.** The workflows package (`packages/workflow`) is not the right home — evals are dev tooling, not user-facing runs.
- **A model router.** Ramp's territory. The harness's job is to produce the data a router would consume.
- **Engine schema changes as a prerequisite.** The harness works today against the engine as-is. Adding `usage`/`cost` to `MessageEntry` is a nice-to-have future in-product change (see §6), not a harness dependency.
- **Multi-turn conversational eval simulation.** Each task is one prompt → one settled submission. Multi-turn user simulation is a separate design.

## 3. Engine primitives we lean on

Every path:line reference below is on `dev-v2` at time of writing. The harness composes these; it does not modify them.

### 3.1 Engine + Session as a library

```ts
// packages/engine/src/engine.ts:26
const engine = new Engine({ providers });      // providers: ProviderBundle
const session = await engine.createSession({   // CreateSessionOptions
  userId, orgId, workspace,
  sandbox: { workspace },
  model,                                       // pi-ai Model<any> — REQUIRED
  systemPrompt, tools, roles, skills,
  resolveModel,                                // host seam, per-turn resolution
});
```

- `Engine.createSession` / `Engine.restoreSession` / `Engine.getSession` / `Engine.deleteSession` — full lifecycle in-process (`engine.ts:26-71`).
- No API server needed. `bin/repl.ts:105-207` is the canonical headless-run wiring.

### 3.2 Model configuration — per-session, per-thread, per-prompt

Layered resolution at turn start (`thread.ts:1045-1080`):

```
thread.modelOverride  (Thread.setModel or PromptOptions.model)
  → session.options.model   (CreateSessionOptions.model, required)
  → host default            (via resolveModel seam)
```

Points of control:
- `CreateSessionOptions.model: Model<any>` — required, per-session default (`types.ts:1149`).
- `CreateSessionOptions.resolveModel?: (spec: string) => Promise<ResolvedModel | null>` — host seam that returns `{ model, apiKey? }` per turn (`types.ts:1132, 1173`). `apiKey` is held for that turn only and cleared at turn end (`thread.ts:207-213`). Key rotation is per-turn granular.
- `PromptOptions.model?: string` — one-shot override per submission (`types.ts:217`).
- `RoleSpec.model?: string` — a role carries its own model (`types.ts:1105`). Applied via `PromptOptions.role` or the `switch_model` built-in tool.
- Internal fallback resolver `resolveModelId(spec)` tries `provider/model` split, else `anthropic → openai → google` for bare ids (`thread.ts:3113-3126`).

Keys flow via env vars (pi-ai `getEnvApiKey` fallback) or a `credentialResolver` (`types.ts:1201`). The harness's `resolveModel` implementation reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. from env — same as `bin/repl.ts:110`.

### 3.3 Structured output scoring

```ts
// packages/engine/src/result-schema.ts
export function extractStructuredOutput(text: string, schema: TSchema): { output?, error? };
```

- Looks for the **last** fenced ` ```json ` block, else the whole trimmed text.
- `JSON.parse` + `Value.Check(schema, parsed)` (typebox).
- Wired via `AwaitResultOptions.resultSchema` (`types.ts:171`); `Thread.buildResult` calls it and stamps `SubmissionResult.output` / `.error` (`thread.ts:2897-2926`).

This is the **primary hook for objective scoring**: define a typebox schema per task, every model's `SubmissionResult` either yields a typed `output` or a schema-mismatch error.

### 3.4 `awaitResult` — sync completion wait

```ts
// packages/engine/src/thread.ts:2868
async awaitResult(queueItemId: string, opts: AwaitResultOptions = {}): Promise<SubmissionResult>
// { queueItemId, outcome: 'completed'|'failed'|'aborted'|'superseded'|'merged',
//   text?, output?, error? }
```

Subscribes to `submission_settled` events with a durable poll fallback (`thread.ts:2940-3002`). Bounded by `AwaitResultOptions.timeoutMs` and `.signal`. Merged-submission delegation is depth-bounded (`MAX_MERGE_DELEGATION_DEPTH`).

### 3.5 Fan-out via `ChildSpawner` + `task` tool

```ts
// packages/engine/src/types.ts:1319, 1338
export interface SpawnChildRequest { prompt; title?; repo?; branch?; model?; }
export type ChildSpawner = (req, ctx) => Promise<SpawnChildResult>;

// packages/engine/src/builtin-tools/index.ts:359
export const taskTool = defineTool({ name: "task", ... });
```

- Engine primitive is the `ChildSpawner` type + `task` built-in tool. Actual spawning is host-injected via `CreateSessionOptions.toolConfig.childSpawner` (`types.ts:1244`).
- Child-of-child is blocked **by omission**: `childSessionFor` (`packages/api/src/engine/host.ts:1191-1194`) deliberately omits `childSpawner` from the child's `toolConfig`. This is a decision, not a hard block — the harness can inject a spawner into children too if it wants grandchildren.
- Results flow back as a `child.settled` signal on the parent thread (`packages/api/src/orchestrator/children.ts:342-391`), keyed idempotently by `dispatchId: settled:{childSessionId}:{queueItemId}`. `ChildWatcher.rearm()` at boot re-arms every unsettled watch — restart-safe (`children.ts:400-410`).

### 3.6 Idempotent admission

`PromptOptions.dispatchId?` (`types.ts:222`): re-submitting the same dispatchId returns the existing submission. **Critical for eval reruns** — a crashed harness re-submitting `eval:{taskId}:{modelId}` won't create duplicates.

### 3.7 Event bus for tracing

`EngineEvent` union (`types.ts:731-801`) is what the bus emits. Durable events (all except `text_delta`) land in `engine_events` (Postgres migration `packages/store-postgres/migrations/pg/0000_engine.sql`):

```sql
CREATE TABLE engine_events (
  session_id text, seq int, event_key text,
  thread_id text, queue_item_id text, user_id text,
  event_type text, payload text (JSON), timestamp bigint,
  PRIMARY KEY (session_id, seq)
);
CREATE UNIQUE INDEX engine_events_event_key ON engine_events (session_id, event_key);
```

Live subscription: `providers.stream.subscribe(filter, cb)` (`types.ts:850`). Durable readback: `providers.stream.read(sessionId, { fromOffset, limit })` (`types.ts:843`).

Available for trace comparison across models:
- Turn count (count assistant `message_end` per queueItemId).
- Tool-call count + sequence (`tool_start` / `tool_end` order + names + args).
- Wall-clock duration (event timestamps).
- Errors, gates hit, model switches.
- Final assistant text.

## 4. Harness architecture

### 4.1 Placement

Two viable homes:
- **`packages/evals/` in-repo, `private: true`.** Trivially imports `@valet/engine` via workspace protocol. Keeps eval sets versioned with the code they test. Recommend this for the MVP.
- **`tkhq/test-agents-infra` external repo.** Cleaner separation, easier to point at multiple valet versions or at pi-agent-core directly. Adopt if the eval set grows beyond ~50 tasks or picks up non-Valet backends. Not needed day 1.

Recommendation: start in-repo (`packages/evals/`), migrate out later if it grows. [uncertain: whether `tkhq/test-agents-infra` already exists or is aspirational — Conner mentioned it as a possibility, not a fact. Confirm before assuming.]

### 4.2 Package shape (proposed)

```
packages/evals/
  package.json          # private, deps: @valet/engine, @valet/store-postgres (optional),
                        # @mariozechner/pi-ai (for getModel + registerFauxProvider)
  bin/
    run.ts              # CLI: `pnpm --filter @valet/evals run -- --set core --models opus,haiku,gpt5`
  src/
    harness.ts          # runTask(task, modelConfig, providers) → TaskResult
    scoring.ts          # schema check + behavioral verifier runner
    tracing.ts          # bus subscriber that records per-turn usage/tool events
    report.ts           # markdown + JSON report generation
    types.ts            # Task, ModelConfig, TaskResult, EvalReport
  sets/
    core/               # eval set 1: general Valet-shaped tasks
      task-001.md
      task-002.md
      ...
  results/              # gitignored except a .keep; harness writes here
```

### 4.3 Eval set format

Markdown-with-frontmatter, matching the roles/skills parser (`packages/engine/src/roles-skills/parser.ts`) so we get consistent loading:

```markdown
---
id: task-001
title: Extract structured event data
tags: [structured-output, low-difficulty]
timeoutMs: 60000
resultSchema:                        # optional typebox JSON schema
  type: object
  required: [date, participants]
  properties:
    date: { type: string, format: date }
    participants: { type: array, items: { type: string } }
verifier: verifiers/task-001.ts      # optional behavioral verifier module
---

# Prompt

Given the following meeting notes, extract the date and participant list as JSON.

<notes>
...
</notes>
```

**Task shape (`packages/evals/src/types.ts`):**

```ts
export interface Task {
  id: string;
  title: string;
  prompt: string;
  timeoutMs?: number;
  resultSchema?: TSchema;                    // optional; enables extractStructuredOutput
  verifier?: (result: SubmissionResult, trace: TaskTrace) => Promise<Score>;
  tags?: string[];
}

export interface ModelConfig {
  id: string;                                // e.g. 'anthropic/claude-opus-4-7', 'openai/gpt-5.6'
  displayName?: string;
  systemPrompt?: string;                     // per-config override, optional
  // Planner/executor split (§5):
  plannerModelId?: string;                   // when set, this config runs planner→executor
  executorModelId?: string;
  splitMode?: 'role' | 'spawn';              // single-trace via roles, or nested via task tool
}

export interface Score {
  passed: boolean;
  score: number;                             // 0..1
  reasons: string[];
}

export interface TaskTrace {
  events: DeliveredBusEvent[];               // captured live from the bus
  turns: number;
  toolCalls: Array<{ name: string; args: unknown; isError: boolean; }>;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  wallClockMs: number;
}

export interface TaskResult {
  taskId: string;
  modelConfig: ModelConfig;
  outcome: SubmissionResult['outcome'];
  finalText?: string;
  score: Score;
  trace: TaskTrace;
  sessionId: string;
  queueItemId: string;
}
```

### 4.4 Core loop

```ts
// packages/evals/src/harness.ts (sketch)
export async function runTask(
  task: Task,
  modelConfig: ModelConfig,
  deps: { providers: ProviderBundle; sandboxProvider?: SandboxProvider; runId: string },
): Promise<TaskResult> {
  const engine = new Engine({ providers: deps.providers });

  // Deterministic session id: enables idempotent re-runs.
  const sessionId = `eval-${deps.runId}-${task.id}-${modelConfig.id.replace(/\W/g, '_')}`;

  const model = resolveModelById(modelConfig.id);
  const trace = attachTraceRecorder(deps.providers.stream, sessionId);

  const session = await engine.createSession({
    id: sessionId,
    userId: 'evals',
    orgId: 'evals',
    workspace: '/',
    sandbox: {},                             // VirtualSandbox by default
    model,
    resolveModel: makeResolveModel(),        // env-key based
    systemPrompt: modelConfig.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    tools: [/* per-set tool allowlist */],
    roles: modelConfig.splitMode === 'role' ? buildSplitRoles(modelConfig) : undefined,
    toolConfig: modelConfig.splitMode === 'spawn'
      ? { childSpawner: buildEvalChildSpawner(engine, modelConfig) }
      : undefined,
  });

  const receipt = await session.prompt(task.prompt, {
    dispatchId: `${sessionId}:main`,         // idempotent
    resultSchema: task.resultSchema,
    ...(modelConfig.splitMode === 'role' ? { role: 'planner' } : {}),
  });

  const result = await session.thread().awaitResult(receipt.queueItemId, {
    timeoutMs: task.timeoutMs ?? 120_000,
    resultSchema: task.resultSchema,
  });

  const taskTrace = trace.finalize();
  const score = task.verifier
    ? await task.verifier(result, taskTrace)
    : defaultScore(result, task.resultSchema);

  await engine.deleteSession(sessionId);     // clean up unless --keep-sessions
  return { taskId: task.id, modelConfig, outcome: result.outcome, finalText: result.text,
           score, trace: taskTrace, sessionId, queueItemId: receipt.queueItemId };
}
```

### 4.5 Providers

- **Store:** `InMemorySessionStore` for MVP (`packages/engine/src/providers/in-memory/`), Postgres (`@valet/store-postgres`) as an opt-in for larger runs that want persistence between harness invocations.
- **Event stream:** `InMemoryEventStream` for MVP (same rationale). Postgres event stream when using the Postgres store.
- **Sandbox:** `VirtualSandbox` (in-memory) by default — most tasks don't need a real fs. `LocalSandbox` / `DockerSandbox` when tasks require real tool execution (e.g. running a build, editing a repo). Set per-eval-set, not per-task, to keep runs uniform.
- **Credentials:** `InMemoryCredentialStore` if any tools require it.

### 4.6 Parallelism

Two axes:
- **Tasks × models:** the outer product. N models × M tasks = N·M `runTask` invocations. Run in parallel with a semaphore (default 4 concurrent) to avoid provider rate limits.
- **Within-task fan-out:** irrelevant for a single-model run; relevant when `splitMode === 'spawn'` (§5).

## 5. Planner/executor split

The engine supports both patterns; the harness surfaces both via `ModelConfig.splitMode`.

### 5.1 Single-trace split via roles (`splitMode: 'role'`)

One session, one thread, planner and executor roles carry their own models. When the agent "switches roles" via the `switch_model` built-in tool (`builtin-tools/index.ts`), the next turn runs against the role's model.

```ts
roles: [
  { name: 'planner',  content: PLANNER_SYSTEM,  model: modelConfig.plannerModelId  },
  { name: 'executor', content: EXECUTOR_SYSTEM, model: modelConfig.executorModelId },
]
```

Prompt: `session.prompt(task.prompt, { role: 'planner' })` — the planner turn runs on the expensive model, then the agent invokes `switch_model` to hand off, subsequent tool-execution turns run on the cheap model. All events land on one thread — the trace is contiguous.

**Pros:** contiguous transcript, one settlement, simplest to reason about, one `SubmissionResult`.
**Cons:** the agent has to explicitly switch — behavioral, not enforced.

### 5.2 Nested split via `task` tool (`splitMode: 'spawn'`)

The parent session runs on the planner model with `childSpawner` injected. The system prompt tells the planner: *"For each executable step, spawn a child session with `task(...)` using the executor model. Aggregate results."*

```ts
toolConfig: {
  childSpawner: (req, ctx) => harness.spawnChild({
    ...req,
    model: modelConfig.executorModelId,     // forced — planner can't escalate
    parentSessionId: ctx.parentSessionId,
    parentThreadId: ctx.parentThreadId,
  }),
}
```

The child's `SubmissionResult` returns to the planner as a `child.settled` signal on its thread (`packages/api/src/orchestrator/children.ts:342-391`). Trace-wise, we get one parent trace + N child traces; the harness's trace recorder subscribes across all sessions and correlates by parentSessionId.

**Fable→gpt-5.6 works out of the box** (planner is one session, executor children are one hop). **gpt-5.6-children spawning further children is blocked by default** — child `toolConfig.childSpawner` is deliberately omitted (`host.ts:1191-1194`). The harness can override this by injecting a spawner into children too, but doing so needs a hop budget bump (`signalHopBudget`, default `SIGNAL_HOP_BUDGET = 3` — `types.ts:1216`).

**Pros:** cost tracking is per-model per-child (§6 makes this queryable), enforced separation, matches Xiangan's "spawn gpt5.6 subagents" phrasing directly.
**Cons:** more moving parts; trace correlation across sessions is harness work.

Both modes ship. Recommendation: default to `'role'` for simplicity; use `'spawn'` when the eval task naturally decomposes into independent subtasks (SWE-bench-like: plan patches, dispatch per-file edits).

## 6. The cost/token gap

**This is the key finding from the research pass and the one thing the harness has to work around.**

The engine captures per-turn usage live from `turn_end` events into an in-memory field on `Thread`:

```ts
// packages/engine/src/thread.ts:186-189
private lastAssistantUsage:
  | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  | undefined;

// thread.ts:2756-2769 (turn_end handler)
const u = event.message.usage;
this.lastAssistantUsage = {
  input: u.input, output: u.output,
  cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
  total: u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
};
```

**It is used only for compaction thresholding** (`thread.ts:2115`) and then discarded. It is **not** persisted:

- `MessageEntry` (`types.ts:272-297`) has `model?: string` and `stopReason?` but **no `usage` / `cost` fields**.
- `engine_entries` schema (`0000_engine.sql`) matches — no usage columns beyond the compaction-only `token_count_before` / `token_count_after`.
- The durable `EngineEvent` union's `turn_end` variant is `{ type: 'turn_end'; threadId; reason: 'end_turn'|'error'|'abort' }` (`types.ts:749`) — **no usage in the durable payload either**. [uncertain: worth confirming by tracing the store's event-append path — the payload column is stringified `EngineEvent`, so if the type says no usage, the row has no usage. But double-check before designing around it.]

### 6.1 Harness-only fix (MVP path — no engine changes)

Subscribe to the event bus, intercept `turn_end` **before** the durable append if possible, or capture it live during the run:

```ts
// packages/evals/src/tracing.ts (sketch)
export function attachTraceRecorder(stream: EventStream, sessionId: string): TraceRecorder {
  const events: DeliveredBusEvent[] = [];
  const toolCalls: TaskTrace['toolCalls'] = [];
  let usage: TaskTrace['usage'];

  const unsub = stream.subscribe({ sessionId }, (busEvent) => {
    events.push(busEvent);
    const ev = busEvent.event;
    if (ev.type === 'tool_start') toolCalls.push({ name: ev.tool, args: ev.args, isError: false });
    if (ev.type === 'tool_end' && toolCalls.length > 0) {
      toolCalls[toolCalls.length - 1].isError = ev.isError;
    }
    // turn_end payload doesn't currently carry usage; we can't get it from the bus alone.
    // Workaround: patch the resolveModel seam to wrap the pi-ai Model with a usage sink,
    // OR read Thread.lastAssistantUsage via a test-helper accessor we add locally.
  });

  return {
    finalize(): TaskTrace {
      unsub();
      return { events, turns: countTurns(events), toolCalls, usage, cost: computeCost(usage, ...) };
    },
  };
}
```

**Concrete workaround for `usage`:** wrap the pi-ai `Model` in the harness's `resolveModel` implementation with a proxy that records the last `usage` from `StreamOptions` callbacks. This is possible because pi-agent-core streams usage through per-request callbacks; the harness owns the model instance and can attach a recorder. Cost is derived from the model's pricing table (already in pi-ai's registry — the same source `SubmissionResult` would use if the field existed).

This is ugly. It's also good enough for the MVP and requires zero engine changes.

### 6.2 Optional future in-product fix (NOT required for harness)

The already-drafted `docs/specs/2026-07-16-usage-telemetry-design.md` proposes adding a `turn_usage` engine event (decision 1 of that spec) emitted from the same `turn_end` handler where `lastAssistantUsage` is captured, carrying `{ model, usage: {4 fields + total}, cost?: {...}, turnDurationMs, queueItemId }`. If/when that ships, the harness's tracing layer becomes: subscribe to `turn_usage` events, done.

**Explicitly NOT required for the harness to land.** The harness ships first, wraps the model, moves on. If the telemetry spec ships later, the harness drops the wrap and consumes the event.

An even smaller change would be adding `usage`/`cost` fields to `MessageEntry` (types.ts) + `engine_entries` (migration) and writing them in the `turn_end` handler. Small, isolated, unlocks post-hoc analysis for the whole product. Also not required.

## 7. Scoring

Two orthogonal scoring axes:

### 7.1 Objective correctness (per task)

- **`resultSchema`-based:** typebox schema attached to the task; `extractStructuredOutput` (`result-schema.ts`) yields `output` (pass) or `error` (fail). Cheap, deterministic, no LLM judge.
- **Behavioral verifier (DeepSWE-style):** a hand-written TypeScript module attached to the task via frontmatter `verifier:`, given `(result, trace)` and returning `Score`. Explicitly encouraged over string-match: check *what the agent did*, not *what it said*. Examples:
  - "Did the agent call `read` on the right file before answering?"
  - "Does the final `write`n content compile / pass a specific test?"
  - "Did the agent avoid destructive `bash` calls?"

Both can coexist on one task. A task with both passes iff schema check AND verifier both pass.

### 7.2 Comparative axes (per model)

Aggregated across the eval set. Same axes DeepSWE plots:

| Axis | Source |
|---|---|
| Success rate | `Score.passed` fraction over tasks |
| Cost per task ($) | usage × pi-ai model pricing table (§6 recorder) |
| Output tokens per task | `usage.output` recorder |
| Agent steps (turns) | count of assistant `message_end` events per submission |
| Tool calls per task | count of `tool_start` events |
| Wall-clock per task | timestamp of `turn_end` (final) minus `message_start` (first) |
| Error rate | fraction of tasks with `tool_end.isError` or `error` events |

Report format (`packages/evals/src/report.ts`):
- **JSON:** machine-readable full result, checked into `results/{runId}/results.json`.
- **Markdown table:** one row per model, columns per axis, plus per-task breakdowns collapsed by tag. This is what gets shared in Slack / posted to a PR.

## 8. Open questions

1. **Parallelism caps.** The reference `buildChildSpawner` enforces `MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR` and `ORG_ACTIVE_SESSION_CEILING` (`packages/api/src/orchestrator/limits.ts`, imported at `children.ts:36`). The harness bypasses `buildChildSpawner` (it's api-layer code) and injects its own spawner — but should the harness enforce its own caps for `splitMode: 'spawn'`? Probably yes, with harness-local constants, to avoid hammering providers with a runaway plan tree. Also `signalHopBudget` default 3 (`types.ts:1216`) — grandchildren need this bumped if we ever inject spawners deeper.

2. **Where do results persist?** MVP: JSON files under `packages/evals/results/{runId}/`, one file per run, gitignored. Alternatives if the run history matters:
   - New table `eval_runs` / `eval_task_results` in `packages/api/src/schema/index.ts` (follows the workflow/childWatches pattern). Overkill for MVP; adopt if we want cross-run diffs in a UI.
   - Piggyback on `QueueItem.metadata` (`types.ts:131`) or `SessionData.metadata` — cheap but not queryable without JSON operators.

   Recommend files-first, table-later if needed.

3. **Relationship to `tkhq/test-agents-infra`.** If that repo exists / is planned, the harness likely wants to live there long-term (not in `tkhq/valet`) so it can point at multiple Valet versions and adjacent runtimes. For now, in-repo is simpler — decide the split when we have 20+ tasks and a real user (Xiangan, us).

4. **Deterministic reruns for harness self-tests.** `registerFauxProvider` from `@mariozechner/pi-ai` (used throughout `packages/engine/test/`, e.g. `happy-path.test.ts:2`) is a canned-message model provider. The harness's own tests should use it — a "does the scoring layer work?" test with a real model would be nondeterministic and expensive. Wire a `--faux` flag on the CLI that swaps `resolveModel` to return the faux model; each task's expected canned response lives next to the task file.

5. **Contamination.** DeepSWE's contamination framing (task must post-date model training cutoff) is nontrivial to guarantee. For internal use we mostly don't care — we're comparing models on tasks we designed, not claiming generalized capability. But if we ever publish a leaderboard: cutoff-date filtering on tasks, and don't reuse tasks that leak into publicly-crawled sources.

6. **Sandbox choice per set.** `VirtualSandbox` is free but doesn't run real tools (its `exec` is a stub). `LocalSandbox` runs against the host filesystem — realistic but leaky and requires per-task cleanup. `DockerSandbox` is the middle ground. Recommend: virtual for structured-output-only sets, docker for anything that touches files or shells.

7. **Model registry coverage.** pi-ai's model registry (`packages/engine/src/thread.ts:3113-3126` resolves through `getModel`) determines which providers work zero-config. New frontier models drop before pi-ai supports them — the harness may need to pin a pi-ai version or add a shim. [uncertain: pi-ai's release cadence and how additive their registry changes are — worth a look before publishing.]

## Not in this pass

- No engine changes.
- No product surface.
- No API routes.
- No `agent_sessions` / `child_watches` / any Postgres migration.
- No workflow-package touchpoint.
- No routing / model-selection logic. Consumers of eval data decide their own routing policy.
