# Engine v2 Phase 0 — De-risking Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the two unverified assumptions the engine v2 design leans on — (1) pi-agent-core can resume a turn from rehydrated SQLite state with a fabricated tool result, and (2) the durable-submission fencing contract is expressible as single-statement conditional writes in better-sqlite3 — before any Phase 1 production code is written.

**Architecture:** Two standalone, checked-in experiment scripts (no production code, no test-suite integration). Spike 1 exercises `runAgentLoopContinue` from `@mariozechner/pi-agent-core` 0.73.0 against the real Anthropic API using a transcript that has been JSON round-tripped (simulating SQLite text-column persistence). Spike 2 opens two `better-sqlite3` connections on one WAL-mode database file and demonstrates claim/replace/fenced-append as CAS writes with zombie-writer rejection. Each spike ends with a FINDINGS note that Phase 1's plan will consume.

**Tech Stack:** TypeScript via `tsx`, `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 0.73.0 (already pinned in `packages/engine`), `typebox`, `better-sqlite3` (already in `packages/store-sqlite`), `node:assert`.

## Global Constraints

- Node 22 required: `source ~/.nvm/nvm.sh && nvm use 22.22.2` before any command in this plan. Node 20 is the shell default and will break `better-sqlite3`.
- `pnpm install` has already been run at the repo root with Node 22. If `better-sqlite3` throws `ERR_DLOPEN_FAILED` / ABI errors, run `pnpm rebuild better-sqlite3` from the repo root.
- The Anthropic key is NOT in the shell env. Load it per-command: `set -a && source /Users/connerswann/code/valet/.env && set +a` (never print it).
- Spikes are experiments: they live outside `src/`, are excluded from typecheck/build/test pipelines, and are run manually with `tsx`. They must still follow the CLAUDE.md type-safety rules (no `any` beyond what pi-ai's own types force, no `@ts-ignore`, no double-casts).
- Use the cheapest real model that supports tool use + thinking: `claude-haiku-4-5` as primary, `claude-sonnet-4-5` for the model-switch leg. If `getModel("anthropic", <id>)` throws for either id, list valid ids via the error message / `@mariozechner/pi-ai`'s model registry and substitute the closest current Anthropic ids — record the substitution in FINDINGS.
- Findings notes record what was actually observed, including failures. A spike that discovers a blocker is a SUCCESS for this phase — do not massage a failure into a pass. Assertions must check content, not just definedness (per CLAUDE.md: `expect(result).toBeDefined()`-style checks are insufficient).
- Commit after each task. No Co-Authored-By trailers.

## Why these two spikes (context for the implementer)

Phase 1 will rewrite the engine's turn loop so that: (a) a process crash mid-turn leaves an assistant entry with dangling tool calls in SQLite, and on restart the reconciler rehydrates the transcript, injects the persisted/fabricated tool results, and calls `agentLoopContinue` to finish the turn; and (b) a crashed owner's lease is taken over by a reconciler that bumps the submission's `attempt_id`, after which any write from the old (zombie) process must be rejected by the store, not by cooperation. If pi-agent-core rejects fabricated continuation state, Phase 1 needs a different resume design. If SQLite can't express the fence as atomic conditional writes, Phase 1 needs a different concurrency design. That is the entire purpose of this phase.

Key upstream contract (from `pi-agent-core/dist/agent-loop.d.ts`, verbatim):

> Continue an agent loop from the current context without adding a new message. **Important:** The last message in context must convert to a `user` or `toolResult` message via `convertToLlm`.

---

### Task 1: pi-agent-core continuation spike

**Files:**
- Create: `packages/engine/experiments/continuation-spike.ts`
- Create: `packages/engine/experiments/FINDINGS-continuation.md`

**Interfaces:**
- Consumes: `runAgentLoopContinue(context: AgentContext, config: AgentLoopConfig, emit: AgentEventSink): Promise<AgentMessage[]>` and types `AgentContext`, `AgentLoopConfig`, `AgentTool`, `AgentEvent` from `@mariozechner/pi-agent-core`; `completeSimple(model, context, options)`, `getModel(provider, id)`, and types `AssistantMessage`, `ToolResultMessage`, `UserMessage`, `Message`, `ToolCall` from `@mariozechner/pi-ai`.
- Produces: `FINDINGS-continuation.md` with a verdict per scenario (A–E below) that the Phase 1 plan will cite. No code interfaces.

The spike runs five scenarios. Each scenario prints `SCENARIO <letter>: PASS/FAIL — <one-liner>` and the script exits non-zero if any scenario has an unexpected outcome (D and E record observations rather than pass/fail — see below).

- **A — Capture a dangling tool call.** Use `completeSimple` (not the agent loop) with a `calc` tool defined so the model stops at `stopReason: "toolUse"` without anything executing. This is exactly the state a crash leaves in `engine_entries`: assistant message persisted at `message_end`, no tool result. Assert the captured message has ≥1 `toolCall` content block.
- **B — Rehydrate + fabricate + continue (the core question).** JSON round-trip the `[user, assistant]` transcript through a temp file (simulating SQLite text columns). Fabricate a `ToolResultMessage` for the dangling `toolCallId` with the correct answer. Build an `AgentContext` ending in that toolResult and call `runAgentLoopContinue`. Assert: the loop completes, the final assistant message has `stopReason: "stop"`, and its text contains the fabricated result value (proving the model consumed the injected result rather than re-deriving or erroring).
- **C — Parallel dangling tool calls.** Same as A/B but with a prompt engineered to elicit two tool calls in one assistant message; fabricate BOTH results; continue. Anthropic rejects requests where a `tool_use` lacks a matching `tool_result`, so this proves multi-result injection ordering works.
- **D — Thinking signatures + model switch (observation, not pass/fail).** Capture a dangling tool call with `reasoning: "low"` on `claude-sonnet-4-5` (assistant message contains `thinking` content with `thinkingSignature`). Continue twice: once on the same model (baseline — expected to work), once on `claude-haiku-4-5` (model switch — Anthropic may reject foreign thinking signatures). Record both outcomes verbatim in FINDINGS, including the API error body if rejected, and whether stripping thinking blocks from the rehydrated assistant message makes the switch succeed. This determines Phase 1's failover rule.
- **E — Cross-provider handoff (observation).** `OPENAI_API_KEY` is available in the shell env. Take the scenario-A Anthropic transcript (with its `toolu_…` tool_use ids) and continue on `getModel("openai", "gpt-4o-mini")` (or nearest available OpenAI model in the registry). Record whether OpenAI accepts foreign tool-call ids and what pi-ai does with the Anthropic-specific fields. If no OpenAI model resolves, record SKIPPED with the reason.

- [ ] **Step 1: Write the spike script**

Create `packages/engine/experiments/continuation-spike.ts`:

```typescript
/**
 * Phase 0 spike: can pi-agent-core resume a turn from rehydrated SQLite state
 * with a fabricated tool result? See FINDINGS-continuation.md for results.
 *
 * Run (from repo root):
 *   set -a && source .env && set +a && \
 *   pnpm --filter @valet/engine exec tsx experiments/continuation-spike.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import {
  completeSimple,
  getModel,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@mariozechner/pi-ai";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY missing. Run: set -a && source .env && set +a");
  process.exit(1);
}

const PRIMARY = getModel("anthropic", "claude-haiku-4-5" as never);
const THINKING = getModel("anthropic", "claude-sonnet-4-5" as never);

const calcTool: AgentTool = {
  name: "calc",
  label: "Calculator",
  description: "Evaluate an arithmetic expression and return the numeric result.",
  parameters: Type.Object({ expression: Type.String() }),
  execute: async (_id, params) => ({
    // If the loop ever calls this during a continuation, that is itself a
    // finding: continuation re-executed a tool instead of using history.
    content: [{ type: "text", text: `LIVE-EXEC:${JSON.stringify(params)}` }],
    details: undefined,
  }),
};

const loopConfig = (model: typeof PRIMARY): AgentLoopConfig => ({
  model,
  apiKey,
  convertToLlm: (messages) =>
    messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
    ) as Message[],
});

function userMsg(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function toolCallsOf(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function fabricatedResult(call: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

/** Simulate SQLite persistence: serialize to a text file, read back, parse. */
function sqliteRoundTrip<T>(label: string, value: T): T {
  const dir = mkdtempSync(join(tmpdir(), "continuation-spike-"));
  const file = join(dir, `${label}.json`);
  writeFileSync(file, JSON.stringify(value));
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function continueLoop(
  context: AgentContext,
  model: typeof PRIMARY,
): Promise<{ final: AssistantMessage; events: AgentEvent["type"][]; toolExecuted: boolean }> {
  const events: AgentEvent["type"][] = [];
  let toolExecuted = false;
  const messages = await runAgentLoopContinue(context, loopConfig(model), (e) => {
    events.push(e.type);
    if (e.type === "tool_execution_start") toolExecuted = true;
  });
  const assistants = messages.filter(
    (m): m is AssistantMessage => m.role === "assistant",
  );
  assert.ok(assistants.length > 0, "continuation produced no assistant message");
  return { final: assistants[assistants.length - 1], events, toolExecuted };
}

async function captureDangling(
  model: typeof PRIMARY,
  prompt: string,
  opts: { reasoning?: "low" } = {},
): Promise<{ user: UserMessage; assistant: AssistantMessage }> {
  const user = userMsg(prompt);
  const assistant = await completeSimple(
    model,
    {
      systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
      messages: [user],
      tools: [calcTool],
    },
    { apiKey, ...opts },
  );
  return { user, assistant };
}

const results: string[] = [];
let failed = false;
function report(scenario: string, ok: boolean | "OBSERVED", detail: string): void {
  const tag = ok === "OBSERVED" ? "OBSERVED" : ok ? "PASS" : "FAIL";
  if (ok === false) failed = true;
  const line = `SCENARIO ${scenario}: ${tag} — ${detail}`;
  console.log(line);
  results.push(line);
}

// ---------------------------------------------------------------- Scenario A
const a = await captureDangling(PRIMARY, "What is 7 * 6? Use the calc tool.");
{
  const calls = toolCallsOf(a.assistant);
  report(
    "A",
    a.assistant.stopReason === "toolUse" && calls.length >= 1,
    `stopReason=${a.assistant.stopReason}, toolCalls=${calls.length}`,
  );
}

// ---------------------------------------------------------------- Scenario B
{
  const rehydrated = sqliteRoundTrip("b", [a.user, a.assistant] as Message[]);
  const call = toolCallsOf(rehydrated[1] as AssistantMessage)[0];
  const context: AgentContext = {
    systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
    messages: [...rehydrated, fabricatedResult(call, "42")],
    tools: [calcTool],
  };
  try {
    const { final, toolExecuted } = await continueLoop(context, PRIMARY);
    const text = final.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    report(
      "B",
      final.stopReason === "stop" && text.includes("42") && !toolExecuted,
      `stopReason=${final.stopReason}, mentions42=${text.includes("42")}, reExecutedTool=${toolExecuted}`,
    );
  } catch (err) {
    report("B", false, `continuation threw: ${String(err)}`);
  }
}

// ---------------------------------------------------------------- Scenario C
{
  const c = await captureDangling(
    PRIMARY,
    "Compute 3 * 5 and 10 * 10. Call the calc tool twice, once per expression, in a single response.",
  );
  const calls = toolCallsOf(c.assistant);
  if (calls.length < 2) {
    report("C", "OBSERVED", `model made ${calls.length} tool call(s); parallel injection untested — retry with a stronger prompt before recording`);
  } else {
    const rehydrated = sqliteRoundTrip("c", [c.user, c.assistant] as Message[]);
    const rcalls = toolCallsOf(rehydrated[1] as AssistantMessage);
    const context: AgentContext = {
      systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
      messages: [
        ...rehydrated,
        fabricatedResult(rcalls[0], "15"),
        fabricatedResult(rcalls[1], "100"),
      ],
      tools: [calcTool],
    };
    try {
      const { final, toolExecuted } = await continueLoop(context, PRIMARY);
      const text = final.content
        .filter((cc) => cc.type === "text")
        .map((cc) => cc.text)
        .join(" ");
      report(
        "C",
        final.stopReason === "stop" && text.includes("15") && text.includes("100") && !toolExecuted,
        `stopReason=${final.stopReason}, mentionsBoth=${text.includes("15") && text.includes("100")}, reExecutedTool=${toolExecuted}`,
      );
    } catch (err) {
      report("C", false, `continuation threw: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------- Scenario D
{
  const d = await captureDangling(THINKING, "What is 12 * 12? Use the calc tool.", {
    reasoning: "low",
  });
  const hasThinking = d.assistant.content.some((c) => c.type === "thinking");
  const call = toolCallsOf(d.assistant)[0];
  if (!call) {
    report("D", "OBSERVED", "no tool call captured on thinking model; rerun before recording");
  } else {
    const rehydrated = sqliteRoundTrip("d", [d.user, d.assistant] as Message[]);
    const makeCtx = (): AgentContext => ({
      systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
      messages: [...structuredClone(rehydrated), fabricatedResult(call, "144")],
      tools: [calcTool],
    });
    let sameModel = "untested";
    let switched = "untested";
    let switchedStripped = "untested";
    try {
      const r = await continueLoop(makeCtx(), THINKING);
      sameModel = `ok (stopReason=${r.final.stopReason})`;
    } catch (err) {
      sameModel = `threw: ${String(err)}`;
    }
    try {
      const r = await continueLoop(makeCtx(), PRIMARY);
      switched = `ok (stopReason=${r.final.stopReason})`;
    } catch (err) {
      switched = `threw: ${String(err)}`;
    }
    // Retry the switch with thinking blocks stripped from the assistant message.
    try {
      const ctx = makeCtx();
      const asst = ctx.messages[1] as AssistantMessage;
      asst.content = asst.content.filter((c) => c.type !== "thinking");
      const r = await continueLoop(ctx, PRIMARY);
      switchedStripped = `ok (stopReason=${r.final.stopReason})`;
    } catch (err) {
      switchedStripped = `threw: ${String(err)}`;
    }
    report(
      "D",
      "OBSERVED",
      `hasThinking=${hasThinking}; sameModel=${sameModel}; switched=${switched}; switchedThinkingStripped=${switchedStripped}`,
    );
  }
}

// ---------------------------------------------------------------- Scenario E
{
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    report("E", "OBSERVED", "SKIPPED — no OPENAI_API_KEY");
  } else {
    try {
      const oai = getModel("openai", "gpt-4o-mini" as never);
      const rehydrated = sqliteRoundTrip("e", [a.user, a.assistant] as Message[]);
      const call = toolCallsOf(rehydrated[1] as AssistantMessage)[0];
      const context: AgentContext = {
        systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
        messages: [...rehydrated, fabricatedResult(call, "42")],
        tools: [calcTool],
      };
      const events: AgentEvent["type"][] = [];
      const messages = await runAgentLoopContinue(
        context,
        { ...loopConfig(oai), apiKey: openaiKey },
        (e) => void events.push(e.type),
      );
      const finals = messages.filter((m): m is AssistantMessage => m.role === "assistant");
      const final = finals[finals.length - 1];
      report(
        "E",
        "OBSERVED",
        `anthropic→openai handoff: stopReason=${final?.stopReason}, errorMessage=${final?.errorMessage ?? "none"}`,
      );
    } catch (err) {
      report("E", "OBSERVED", `anthropic→openai handoff threw: ${String(err)}`);
    }
  }
}

console.log("\n--- summary ---");
for (const line of results) console.log(line);
process.exit(failed ? 1 : 0);
```

Note on the two `as never` casts in `getModel` calls: pi-ai's model registry uses literal-union ids; the engine itself uses this exact idiom (`packages/engine/src/thread.ts:1322`). Keep them, matching existing engine convention. If `getModel` throws at runtime for an id, substitute a valid current Anthropic/OpenAI id from the error output and record the substitution in FINDINGS.

- [ ] **Step 2: Run the spike**

```bash
cd /Users/connerswann/code/valet && source ~/.nvm/nvm.sh && nvm use 22.22.2 && \
set -a && source .env && set +a && \
pnpm --filter @valet/engine exec tsx experiments/continuation-spike.ts
```

Expected: `SCENARIO A: PASS`, `SCENARIO B: PASS`, `SCENARIO C: PASS` (or OBSERVED if the model refused parallel calls — rerun up to 3 times to get two calls), `SCENARIO D: OBSERVED — …`, `SCENARIO E: OBSERVED — …`, exit code 0. A FAIL on B is the design-changing outcome — do not "fix" it by weakening the assertion; capture the full error in FINDINGS and stop for review.

If the model ids don't resolve, `getModel` throws immediately — fix the ids first (see Global Constraints), rerun, and note the substitution.

- [ ] **Step 3: Write the findings note**

Create `packages/engine/experiments/FINDINGS-continuation.md` from what the run actually printed (do not copy this skeleton verbatim — fill every ⟨…⟩ from real output):

```markdown
# Findings: pi-agent-core continuation spike

Run: 2026-07-11, pi-agent-core 0.73.0, models ⟨actual ids used⟩.
Script: `experiments/continuation-spike.ts` (rerunnable; requires ANTHROPIC_API_KEY from repo .env).

## Verdict for Phase 1

⟨One paragraph: is the rehydrate → fabricate ToolResult → agentLoopContinue design viable as specced? Any contract adjustments Phase 1 must make?⟩

## Per-scenario results

| Scenario | Result | Notes |
|---|---|---|
| A: capture dangling toolCall via completeSimple | ⟨…⟩ | ⟨…⟩ |
| B: JSON round-trip + fabricated result + continue | ⟨…⟩ | ⟨…⟩ |
| C: two parallel dangling calls, both fabricated | ⟨…⟩ | ⟨…⟩ |
| D: thinking signatures — same-model / switched / switched+stripped | ⟨…⟩ | ⟨exact API error bodies if any⟩ |
| E: anthropic→openai transcript handoff | ⟨…⟩ | ⟨…⟩ |

## Rules Phase 1 must adopt

- ⟨e.g. "model failover mid-turn must strip thinking blocks" — only if observed⟩
- ⟨e.g. "convertToLlm must guarantee the trailing message is user/toolResult; enforce at call site"⟩

## Surprises / gotchas

- ⟨anything unexpected: event ordering, usage accounting on continuations, timestamp handling, …⟩
```

- [ ] **Step 4: Commit**

```bash
cd /Users/connerswann/code/valet && git add packages/engine/experiments/ && \
git commit -m "spike(engine): pi-agent-core continuation from rehydrated state"
```

---

### Task 2: Fence-shaped SQLite CAS spike

**Files:**
- Create: `packages/store-sqlite/experiments/fencing-spike.ts`
- Create: `packages/store-sqlite/experiments/FINDINGS-fencing.md`

**Interfaces:**
- Consumes: `better-sqlite3` (already a dependency of `@valet/store-sqlite`). Nothing from Task 1.
- Produces: `FINDINGS-fencing.md` recording the exact SQL idioms (verbatim statements) that Phase 1's store rewrite will use for `claimSubmission`, `heartbeatLease`, `replaceSubmissionAttempt`, and fenced `appendEntries`. No code interfaces.

**Note:** the roadmap placed both spikes under `packages/engine/experiments/`; this one lives in `packages/store-sqlite/experiments/` instead because that package already has `better-sqlite3` and is the package Phase 1 rewrites. Deliberate deviation, record it nowhere else.

The spike proves five properties on ONE database file opened by TWO separate `Database` connections (connection A = original owner, connection B = reconciler; both WAL mode, `busy_timeout` set):

1. **Claim is CAS.** `claim` = single `UPDATE … SET status='running', attempt_id=?, lease_expires_at=? WHERE id=? AND status='queued'`. A claims → `changes=1`; B immediately re-claims the same row → `changes=0`. Exactly one winner, no read-then-write window.
2. **Lease takeover is CAS.** B performs `replaceSubmissionAttempt` = `UPDATE … SET attempt_id=?, lease_expires_at=? WHERE id=? AND status='running' AND attempt_id=? AND lease_expires_at < ?` — succeeds only when the old attempt id matches AND the lease is expired (test all three rejection legs: wrong attempt, unexpired lease, wrong status).
3. **Zombie heartbeat rejected.** After takeover, A's `heartbeat` (`UPDATE … SET lease_expires_at=? WHERE id=? AND attempt_id=?` with A's old attempt id) → `changes=0`.
4. **Fenced append is a single conditional statement.** `INSERT INTO entries (…) SELECT …columns… WHERE EXISTS (SELECT 1 FROM submissions WHERE id=? AND attempt_id=?)`. B (current attempt) → `changes=1`; A (stale attempt) → `changes=0`. The fence and the write are one statement — no check-then-insert race.
5. **Multi-row fenced append is atomic.** A transaction that re-checks the fence and inserts N rows either lands all N or zero. Demonstrate the zero case by running A's stale-fenced 3-row batch after takeover: 0 rows land. Also demonstrate that `better-sqlite3`'s synchronous transactions + WAL give this without SERIALIZABLE gymnastics.

- [ ] **Step 1: Write the spike script**

Create `packages/store-sqlite/experiments/fencing-spike.ts`:

```typescript
/**
 * Phase 0 spike: express engine-v2 submission fencing (claim / lease takeover /
 * fenced append) as single-statement CAS writes in better-sqlite3, and prove a
 * zombie writer is rejected. See FINDINGS-fencing.md for results.
 *
 * Run (from repo root):
 *   pnpm --filter @valet/store-sqlite exec tsx experiments/fencing-spike.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dbPath = join(mkdtempSync(join(tmpdir(), "fencing-spike-")), "spike.db");

function connect(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

const admin = connect();
admin.exec(`
  CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL,             -- queued|running|terminalizing|settled
    attempt_id TEXT,
    lease_expires_at INTEGER
  );
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    queue_item_id TEXT NOT NULL,
    body TEXT NOT NULL
  );
`);
admin.prepare(
  "INSERT INTO submissions (id, thread_id, status) VALUES ('sub1', 't1', 'queued')",
).run();

// Two independent connections on the same file — two "processes".
const connA = connect(); // original owner (will become the zombie)
const connB = connect(); // reconciler / new owner

const CLAIM = `
  UPDATE submissions SET status = 'running', attempt_id = @attempt, lease_expires_at = @lease
  WHERE id = @id AND status = 'queued'`;
const HEARTBEAT = `
  UPDATE submissions SET lease_expires_at = @lease
  WHERE id = @id AND attempt_id = @attempt AND status = 'running'`;
const REPLACE_ATTEMPT = `
  UPDATE submissions SET attempt_id = @newAttempt, lease_expires_at = @lease
  WHERE id = @id AND status = 'running' AND attempt_id = @oldAttempt AND lease_expires_at < @now`;
const FENCED_APPEND = `
  INSERT INTO entries (id, thread_id, queue_item_id, body)
  SELECT @entryId, @threadId, @itemId, @body
  WHERE EXISTS (SELECT 1 FROM submissions WHERE id = @itemId AND attempt_id = @attempt)`;

const results: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  const line = `${cond ? "PASS" : "FAIL"} — ${name} (${detail})`;
  console.log(line);
  results.push(line);
  assert.ok(cond, name);
}

const now = 1_000_000; // fixed fake clock; leases are plain integers
const leaseA = now + 30_000;

// 1. Claim is CAS: A wins, B's identical claim is a no-op.
const claimA = connA.prepare(CLAIM).run({ id: "sub1", attempt: "attempt-A", lease: leaseA });
check("claim: A wins", claimA.changes === 1, `changes=${claimA.changes}`);
const claimB = connB.prepare(CLAIM).run({ id: "sub1", attempt: "attempt-B", lease: leaseA });
check("claim: B loses CAS on running row", claimB.changes === 0, `changes=${claimB.changes}`);

// A can append while it owns the attempt.
const appendLive = connA.prepare(FENCED_APPEND).run({
  entryId: "e1", threadId: "t1", itemId: "sub1", body: "assistant-partial", attempt: "attempt-A",
});
check("fenced append: live owner writes", appendLive.changes === 1, `changes=${appendLive.changes}`);

// 2. Lease takeover: rejected while unexpired / wrong attempt; succeeds when expired.
const早 = connB.prepare(REPLACE_ATTEMPT).run({
  id: "sub1", newAttempt: "attempt-B", oldAttempt: "attempt-A", lease: now + 60_000, now,
});
check("takeover: rejected while lease unexpired", 早.changes === 0, `changes=${早.changes}`);
const wrongAttempt = connB.prepare(REPLACE_ATTEMPT).run({
  id: "sub1", newAttempt: "attempt-B", oldAttempt: "attempt-X", lease: now + 60_000, now: leaseA + 1,
});
check("takeover: rejected on wrong prior attempt", wrongAttempt.changes === 0, `changes=${wrongAttempt.changes}`);
const takeover = connB.prepare(REPLACE_ATTEMPT).run({
  id: "sub1", newAttempt: "attempt-B", oldAttempt: "attempt-A", lease: leaseA + 60_000, now: leaseA + 1,
});
check("takeover: succeeds after expiry with matching attempt", takeover.changes === 1, `changes=${takeover.changes}`);

// 3. Zombie heartbeat rejected.
const zombieBeat = connA.prepare(HEARTBEAT).run({ id: "sub1", attempt: "attempt-A", lease: leaseA + 120_000 });
check("heartbeat: zombie rejected", zombieBeat.changes === 0, `changes=${zombieBeat.changes}`);

// 4. Fenced append: zombie rejected, new owner accepted — single statement each.
const zombieAppend = connA.prepare(FENCED_APPEND).run({
  entryId: "e2", threadId: "t1", itemId: "sub1", body: "zombie-write", attempt: "attempt-A",
});
check("fenced append: zombie rejected", zombieAppend.changes === 0, `changes=${zombieAppend.changes}`);
const ownerAppend = connB.prepare(FENCED_APPEND).run({
  entryId: "e3", threadId: "t1", itemId: "sub1", body: "reconciler-write", attempt: "attempt-B",
});
check("fenced append: new owner writes", ownerAppend.changes === 1, `changes=${ownerAppend.changes}`);

// 5. Multi-row fenced append is all-or-nothing.
function fencedBatch(db: Database.Database, attempt: string, ids: string[]): number {
  const stmt = db.prepare(FENCED_APPEND);
  const tx = db.transaction((rows: string[]) => {
    let landed = 0;
    for (const entryId of rows) {
      const r = stmt.run({ entryId, threadId: "t1", itemId: "sub1", body: `batch-${attempt}`, attempt });
      if (r.changes === 0) throw new Error("FENCE_REJECTED"); // rolls back the whole batch
      landed += r.changes;
    }
    return landed;
  });
  try {
    return tx(ids);
  } catch (err) {
    if (err instanceof Error && err.message === "FENCE_REJECTED") return 0;
    throw err;
  }
}
const zombieBatch = fencedBatch(connA, "attempt-A", ["e4", "e5", "e6"]);
const zombieRows = (admin.prepare("SELECT COUNT(*) AS n FROM entries WHERE body = 'batch-attempt-A'").get() as { n: number }).n;
check("batch append: zombie batch lands zero rows", zombieBatch === 0 && zombieRows === 0, `returned=${zombieBatch}, rows=${zombieRows}`);
const ownerBatch = fencedBatch(connB, "attempt-B", ["e7", "e8", "e9"]);
check("batch append: owner batch lands all rows", ownerBatch === 3, `returned=${ownerBatch}`);

console.log("\n--- summary ---");
for (const line of results) console.log(line);
console.log(`db: ${dbPath}`);
```

(Replace the `早` variable name with `earlyTakeover` — it is shown here only to flag that you must read this code, not paste it blind. Everything else is intended verbatim.)

- [ ] **Step 2: Run the spike**

```bash
cd /Users/connerswann/code/valet && source ~/.nvm/nvm.sh && nvm use 22.22.2 && \
pnpm --filter @valet/store-sqlite exec tsx experiments/fencing-spike.ts
```

Expected: 11 `PASS` lines, exit 0. If `better-sqlite3` fails to load (ABI mismatch), run `pnpm rebuild better-sqlite3` at the repo root and retry. Any `FAIL` is a design finding — capture it, do not weaken the assertion.

- [ ] **Step 3: Write the findings note**

Create `packages/store-sqlite/experiments/FINDINGS-fencing.md` (fill ⟨…⟩ from the real run):

```markdown
# Findings: SQLite CAS fencing spike

Run: 2026-07-11, better-sqlite3 ⟨version⟩, Node ⟨version⟩, WAL + busy_timeout=5000.
Script: `experiments/fencing-spike.ts` (rerunnable, no network).

## Verdict for Phase 1

⟨One paragraph: the fencing contract is/is not expressible as single-statement CAS
writes; any caveats (WAL requirements, busy_timeout behavior, transaction mode).⟩

## Canonical SQL idioms (copy into the Phase 1 store rewrite)

- claimSubmission: ⟨verbatim UPDATE⟩
- heartbeatLease: ⟨verbatim UPDATE⟩
- replaceSubmissionAttempt: ⟨verbatim UPDATE⟩
- fenced appendEntries (single row): ⟨verbatim INSERT…SELECT…WHERE EXISTS⟩
- fenced appendEntries (batch): fence re-checked per row inside one better-sqlite3
  transaction; first rejection throws → full rollback. ⟨confirm observed⟩

## Property results

| Property | Result |
|---|---|
| claim CAS, exactly one winner | ⟨…⟩ |
| takeover rejected: unexpired lease / wrong attempt | ⟨…⟩ |
| takeover succeeds after expiry | ⟨…⟩ |
| zombie heartbeat rejected | ⟨…⟩ |
| zombie single append rejected (changes=0) | ⟨…⟩ |
| zombie batch lands zero rows | ⟨…⟩ |

## Surprises / gotchas

- ⟨e.g. anything about better-sqlite3 transactions nesting, WAL checkpointing, or
  changes-counting that Phase 1 must know⟩
```

- [ ] **Step 4: Commit**

```bash
cd /Users/connerswann/code/valet && git add packages/store-sqlite/experiments/ && \
git commit -m "spike(store-sqlite): CAS fencing idioms for durable submissions"
```

---

## Phase exit

Both spikes committed with findings notes; verdicts feed directly into the Phase 1 plan (`docs/plans/`, written next). If Scenario B failed or any fencing property failed, STOP — the Phase 1 design in the engine spec needs revision before planning continues.
