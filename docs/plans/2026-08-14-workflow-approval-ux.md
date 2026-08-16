# Workflow Approval UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow `tool` node that hits a `require_approval` policy pauses the run and surfaces an approval gate (once / rest-of-run / always-allow scopes) instead of failing; both policy forms get a service/action typeahead.

**Architecture:** Extend the `invokeAction` seam with a `requiresApproval` outcome; the tool executor parks on the same durable signal machinery the `approval` node uses. "Approve once" is signal-borne (a new host-internal `approval` field on the invoke request); "rest of run" writes the existing exec-scoped runtime grant; "always" reuses the session gate's org-policy write. The resolution route is hardened (parked-gate 409s, org-from-run, human-only policy gates). The run page gets a `PolicyGateCard`; settings get a `ServiceActionCombobox`.

**Tech Stack:** TypeScript monorepo (pnpm), vitest, Hono, Drizzle, React 19 + TanStack Query, Tailwind tokens.

**Spec:** `docs/specs/2026-08-14-workflow-approval-ux-design.md` (rev 2). Read it before starting; it is normative where this plan is silent.

## Global Constraints

- Branch: `conner/workflow-approval-ux` (based on `origin/dev-v2`). Commit per task, subjects ≤72 chars, no AI co-author trailers.
- Node 22 (`nvm use 22`) — `WebSocket is not defined` failures mean wrong Node, not a regression.
- Test invocation: `pnpm --filter @valet/<pkg> test <filter>` with NO `--` before the filter (vitest drops args after `--` and runs the full suite).
- Type safety: no `any`, no `as unknown as T`, no `@ts-ignore`. Build full shapes in tests.
- All user-facing copy (errors, labels, notifications) follows ASD-STE100: short sentences, active voice, and every error names the corrective action when one exists.
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` in place (Task 5 adds a column) + update the Drizzle schema. After editing: `rm -rf ~/.valet/pg` before running the dev stack.
- Signal naming (pinned by the spec): `signalType = approval:{nodeId}{iterationSuffix}`, resolution `signalId = approval:{nodeId}{iterationSuffix}:resolution`, where `iterationSuffix` is `""` at iteration 0 and `:{i}` for i > 0 (`iterationSuffix()` in `packages/workflow/src/nodes/index.ts:103`).
- `packages/workflow` is portable: it must not import from `packages/api` or Drizzle. New host behavior enters through optional callback seams on `NodeExecutorArgs`.

---

### Task 1: `@valet/workflow` contract types

**Files:**
- Modify: `packages/workflow/src/engine-deps.ts:91-107`
- Modify: `packages/workflow/src/dag/nodes.ts:136-155` (ToolNode)
- Modify: `packages/workflow/src/nodes/index.ts:28-51` (OnApprovalPending, new OnGateResolved)
- Test: type-only changes — the package must still compile; behavior tests land in Task 2.

**Interfaces (Produces):**

```ts
// engine-deps.ts
export type WorkflowInvokeActionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }
  | { ok: false; requiresApproval: true; riskLevel?: string; provenance?: string };

export interface WorkflowInvokeActionRequest {
  service: string;
  action: string;
  params: Record<string, unknown>;
  invocationId: string;
  credential?: ToolCredentialMode;
  /** Host-internal single-invocation authorization (spec §1). Set by the
   * tool executor only when it holds an approved, unconsumed resolution
   * signal for exactly this invocation. Never crosses an HTTP boundary. */
  approval?: { resolvedBy: string; note?: string };
}

// dag/nodes.ts — ToolNode gains:
export interface ToolNode {
  // ...existing fields unchanged...
  /** What a denied (or timed-out) policy gate does. 'fail' (default) fails
   * the node; 'skip' completes it with { approved: false, policyDenied:
   * true, resolvedBy } so fromOutput:'false' edges activate. */
  onDeny?: 'fail' | 'skip';
  /** Duration (e.g. "24h"). A gate unresolved past it is a denial with
   * resolvedBy 'timeout'. Omit = wait forever. */
  approvalTimeout?: string;
}

// nodes/index.ts
export type OnApprovalPending = (info: {
  runId: string;
  nodeId: string;
  /** 'approval' = explicit approval node (prompt REQUIRED there by
   * convention); 'policy_gate' = tool node gated by policy. Absent reads
   * as 'approval' for backward compatibility. */
  kind?: 'approval' | 'policy_gate';
  prompt?: string;           // was required; now optional (policy gates have none)
  summary?: string;
  details?: unknown;
  service?: string;          // policy gates only
  action?: string;
  params?: unknown;
  iteration?: number;        // set only when > 0
}) => Promise<void> | void;

/** Host audit seam: the tool executor reports gate settlements the HTTP
 * route cannot see (timeout; denial consumed by the executor). Best-effort
 * — a throw must not abort the node. */
export type OnGateResolved = (info: {
  runId: string;
  nodeId: string;
  iteration: number;
  invocationId: string;
  outcome: 'denied' | 'timeout';
  resolvedBy: string;
}) => Promise<void> | void;

// NodeExecutorArgs gains:
//   onGateResolved?: OnGateResolved;
```

- [ ] **Step 1: Apply the four edits above.** In `engine-deps.ts` replace the `WorkflowInvokeActionResult` line and the request interface; in `dag/nodes.ts` add the two `ToolNode` fields with the doc comments shown; in `nodes/index.ts` widen `OnApprovalPending` (make `prompt` optional, add the new optional fields), add `OnGateResolved`, and add `onGateResolved?: OnGateResolved;` to `NodeExecutorArgs` (after `onApprovalGrant`).

- [ ] **Step 2: Fix the one compile break.** `approval.ts:100-106` calls `onApprovalPending` with a required-`prompt` shape — it still typechecks (extra optional fields). The api host (`packages/api/src/providers/node.ts:383`) reads `info.summary ?? info.prompt` where `prompt` is now `string | undefined` — `title` becomes possibly-undefined. Patch it minimally now (full rework in Task 6):

```ts
title: info.summary ?? info.prompt ?? `Approval needed: ${info.service ?? "?"}.${info.action ?? "?"}`,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean. (`tool.ts` still compiles — the new result member is `ok: false` with no `error`, and `tool.ts:92` reads `response.error` only after `!response.ok`; if TS narrows and errors on the missing `error` prop, add a temporary `'error' in response ? response.error : 'requires approval'` guard — Task 2 rewrites this file anyway.)

- [ ] **Step 4: Commit**

```bash
git add packages/workflow/src packages/api/src/providers/node.ts
git commit -m "feat(workflow): approval-gate contract types on invokeAction seam"
```

---

### Task 2: `executeTool` gate lifecycle (park / resume / deny / timeout)

**Files:**
- Modify: `packages/workflow/src/nodes/tool.ts` (full rewrite below)
- Modify: `packages/workflow/src/nodes/foreach.ts:207` (thread `onGateResolved` into `bodyArgs`, next to `onApprovalPending`)
- Modify: `packages/workflow/src/local-host.ts` + `packages/workflow/src/interpreter.ts`: thread `onGateResolved` from host opts into executor args exactly where `onApprovalPending` is threaded (grep `onApprovalPending` in both files; add the sibling field at every site).
- Test: `packages/workflow/src/nodes/tool.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's types.
- Produces: gate effects on the intent checkpoint — `{ invocationId, gate: true, gateParams, gateParamsTruncated, gateItem?, riskLevel?, provenance?, timeoutAt? }` — Task 7 reads these server-side. Park condition `{ kind: 'signal', nodeId, signalType: 'approval:{nodeId}{suffix}', timeoutAt? }`. Resolution signal payload consumed here: `{ approved: boolean; resolvedBy: string; note?: string; scope?: string; resolvedVia?: string }`.

- [ ] **Step 1: Write the failing tests.** Extend `tool.test.ts` following its existing harness (it already builds `NodeExecutorArgs` with a memory store and a stub `engine`). Add:

```ts
const GATE_RESPONSE = { ok: false as const, requiresApproval: true as const, riskLevel: "high", provenance: "org_policy" };

describe("policy gate", () => {
  it("parks on requiresApproval, persists gate effects, and notifies once", async () => {
    const pending: unknown[] = [];
    const args = makeArgs({
      engine: { invokeAction: async () => GATE_RESPONSE },
      onApprovalPending: (info) => { pending.push(info); },
    });
    const first = await executeTool(args);
    expect(first.status).toBe("parked");
    if (first.status !== "parked") throw new Error("unreachable");
    expect(first.waitingOn).toEqual([
      { kind: "signal", nodeId: "t1", signalType: "approval:t1", timeoutAt: undefined },
    ]);
    const cp = (await args.store.getCheckpoints(args.run.runId)).find((c) => c.nodeId === "t1");
    expect(cp?.effects?.gate).toBe(true);
    expect(cp?.effects?.gateParams).toEqual({ title: "hello" }); // whatever makeArgs renders
    expect(cp?.effects?.riskLevel).toBe("high");
    // re-drive: still parked, no second notification
    const second = await executeTool({ ...args, existingCheckpoint: cp });
    expect(second.status).toBe("parked");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "policy_gate", service: "linear", action: "save_issue" });
  });

  it("approved signal: invokes with the approval field, then consumes signal atomically", async () => {
    const seen: WorkflowInvokeActionRequest[] = [];
    const args = makeArgs({
      engine: { invokeAction: async (req) => { seen.push(req); return seen.length === 1 ? GATE_RESPONSE : { ok: true, result: { id: 9 } }; } },
    });
    await executeTool(args); // parks
    await args.store.insertSignal({
      runId: args.run.runId, signalId: "approval:t1:resolution", signalType: "approval:t1",
      payload: { approved: true, resolvedBy: "u1", note: "go" }, createdAt: 1,
    });
    const cp = (await args.store.getCheckpoints(args.run.runId)).find((c) => c.nodeId === "t1");
    const done = await executeTool({ ...args, existingCheckpoint: cp });
    expect(done).toEqual({ status: "completed", result: { id: 9 } });
    expect(seen[1].approval).toEqual({ resolvedBy: "u1", note: "go" });
    const signals = await args.store.listSignals(args.run.runId, { unconsumed: true });
    expect(signals).toHaveLength(0); // consumed with the terminal checkpoint
  });

  it("denied signal with default onDeny fails the node naming the denier", async () => { /* insert {approved:false,resolvedBy:"u2"}; expect status failed, error containing "u2"; signal consumed */ });

  it("denied signal with onDeny:'skip' completes with policyDenied output", async () => {
    /* node.onDeny = 'skip'; expect { status: "completed", result: { approved: false, policyDenied: true, resolvedBy: "u2", note: undefined } } */
  });

  it("timeout parks with timeoutAt on the wait condition and denies after it", async () => {
    /* node.approvalTimeout = "1h"; clock t0 → park: waitingOn[0].timeoutAt === t0+3600_000 AND effects.timeoutAt persisted.
       Re-drive with clock t0+3600_001 and no signal → failed with error containing "timed out". */
  });

  it("foreach iteration gets the suffixed signal type", async () => {
    /* makeArgs with iteration: 3 → park waitingOn[0].signalType === "approval:t1:3" */
  });

  it("requiresApproval WITH approval field is a defensive terminal failure, not a re-park", async () => {
    /* engine always returns GATE_RESPONSE; park, insert approved signal, re-drive →
       status failed, error mentions the grant write ("approval was recorded but policy enforcement still requires approval"). Signal consumed. */
  });

  it("reports timeout through onGateResolved", async () => {
    /* approvalTimeout elapsed → onGateResolved called with { outcome: "timeout", resolvedBy: "timeout", invocationId: "workflow:<runId>:t1" } */
  });
});
```

Fill each sketched body with real code in the harness's idiom — every `it` above must assert concrete values, never just `toBeDefined()`.

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter @valet/workflow test tool`
Expected: new tests FAIL (parked status never produced; existing tests still pass).

- [ ] **Step 3: Rewrite `executeTool`.** Keep the file's existing helpers (`mintInvocationId`, `isPlainRecord`, `errorMessage`) and doc-comment style. Core shape:

```ts
export async function executeTool(args: NodeExecutorArgs<ToolNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint,
          onApprovalPending, onGateResolved } = args;
  const templateContext = resolveTemplateContext(args);
  const suffix = iterationSuffix(iteration);
  const signalType = `approval:${node.id}${suffix}`;

  let effects = readToolEffects(existingCheckpoint);
  let invocationId = effects.invocationId ?? mintInvocationId(run.runId, node.id, iteration);
  if (existingCheckpoint === undefined) {
    await store.putIntent(intentRow({ invocationId }));
  }

  const renderedParams = renderJsonTemplates<unknown>(node.params, templateContext);
  if (!isPlainRecord(renderedParams)) {
    return await writeTerminal({ status: 'failed', error: `tool node "${node.id}" params template-rendered to a non-object value` });
  }

  // Gate already open? Resolve/timeout/re-park BEFORE any invoke.
  let approval: { resolvedBy: string; note?: string } | undefined;
  let heldSignal: RunSignal | undefined;
  if (effects.gate === true) {
    const signals = await store.listSignals(run.runId, { unconsumed: true });
    heldSignal = signals.find((s) => s.signalType === signalType);
    if (heldSignal) {
      const payload = parseGatePayload(heldSignal.payload);
      if (!payload.approved) return await denyOutcome(payload.resolvedBy, payload.note, heldSignal);
      approval = { resolvedBy: payload.resolvedBy, ...(payload.note !== undefined ? { note: payload.note } : {}) };
    } else if (effects.timeoutAt !== undefined && clock() >= effects.timeoutAt) {
      await onGateResolved?.({ runId: run.runId, nodeId: node.id, iteration, invocationId, outcome: 'timeout', resolvedBy: 'timeout' });
      return await denyOutcome('timeout', undefined, undefined);
    } else {
      return park(effects.timeoutAt);
    }
  }

  let response: WorkflowInvokeActionResult;
  try {
    response = await engine.invokeAction({
      service: node.service, action: node.action, params: renderedParams, invocationId,
      ...(node.credential !== undefined ? { credential: node.credential } : {}),
      ...(approval !== undefined ? { approval } : {}),
    });
  } catch (err) {
    return await writeTerminal({ status: 'failed', error: errorMessage(err) });
  }

  if (!response.ok && 'requiresApproval' in response && response.requiresApproval) {
    if (approval !== undefined) {
      // Spec §1: enforcement honors the approval field. Reaching here means
      // the grant/approval plumbing is broken — fail loudly, never livelock.
      return await writeTerminal({ status: 'failed',
        error: `approval was recorded but policy enforcement still requires approval for ${node.service}.${node.action} — the grant write may have failed; resolve the gate again or check org policies` });
    }
    return await openGate(response);
  }
  if (!response.ok) return await writeTerminal({ status: 'failed', error: response.error });
  return await writeTerminal({ status: 'completed', result: response.result });
}
```

Supporting pieces (all in this file):

- `readToolEffects(cp)`: narrows `cp?.effects` — `invocationId?: string`, `gate?: boolean`, `timeoutAt?: number` (typeof checks, never casts).
- `openGate(response)`: first park. Compute `timeoutAt` from `node.approvalTimeout` via `parseDurationMs` (unparseable → defensive terminal failure, copy the approval node's pattern at `approval.ts:63-86`). Truncate params/item: `const gp = capJson(renderedParams)` where `capJson` stringifies, and over 8192 chars stores `{ truncated: true, preview: json.slice(0, 8192) }` and sets the flag (mirror `capAuditField` in `packages/api/src/policies/service.ts:385` but local — this package cannot import it). Re-`putIntent` with merged effects `{ invocationId, gate: true, gateParams: gp.value, gateParamsTruncated: gp.truncated, ...(args.aliases !== undefined ? { gateItem: capJson(args.aliases).value } : {}), ...(response.riskLevel !== undefined ? { riskLevel: response.riskLevel } : {}), ...(response.provenance !== undefined ? { provenance: response.provenance } : {}), ...(timeoutAt !== undefined ? { timeoutAt } : {}) }` (putIntent replaces an existing intent row — `memory-store.ts:196` — so this is the documented way to grow effects). Then fire `onApprovalPending` (only on this first-open path — keyed off `effects.gate !== true`) with `{ runId, nodeId: node.id, kind: 'policy_gate', service: node.service, action: node.action, params: gp.value, ...(iteration > 0 ? { iteration } : {}) }`, then `return park(timeoutAt)`.
- `park(timeoutAt)`: `{ status: 'parked', waitingOn: [{ kind: 'signal', nodeId: node.id, signalType, ...(timeoutAt !== undefined ? { timeoutAt } : {}) }] }`. `timeoutAt` on the wait condition is REQUIRED for wake-up — both timeout drivers read it from there (`local-host.ts` `scheduleWake` + sweep), not from effects.
- `writeTerminal(outcome)`: builds the terminal `NodeCheckpoint` (carrying `effects: { invocationId }` as today). If `heldSignal` is set, write via `store.consumeSignalAndCheckpoint(heldSignal.signalId, { nodeId: node.id, iteration, attempt }, checkpoint)`; else `store.completeCheckpoint(...)`. Invoke-first-consume-second is the pinned order (spec §2) — the invoker's dedup covers the crash window between invoke and consume.
- `denyOutcome(resolvedBy, note, signal)`: honors `node.onDeny ?? 'fail'`. `'skip'` → completed `{ approved: false, policyDenied: true, resolvedBy, ...(note !== undefined ? { note } : {}) }`. `'fail'` → failed with error `` `${node.service}.${node.action} was denied by ${resolvedBy}` `` (or `` `approval for ${node.service}.${node.action} timed out` `` when resolvedBy === 'timeout'). Also call `onGateResolved?.({ ..., outcome: 'denied', resolvedBy })` for the signal-deny path (route already stamped, host impl is idempotent). Writes through the same consume-or-complete switch as `writeTerminal`.
- `parseGatePayload(payload)`: like `parseApprovalPayload` (`approval.ts:212`) — requires boolean `approved` + string `resolvedBy`, optional string `note`; ignore unknown fields.

- [ ] **Step 4: Thread `onGateResolved`.** `foreach.ts:207` bodyArgs gains `onGateResolved: args.onGateResolved,`; `local-host.ts` + `interpreter.ts`: add the field everywhere `onApprovalPending` is passed (grep both files).

- [ ] **Step 5: Run**

Run: `pnpm --filter @valet/workflow test tool` then the full package: `pnpm --filter @valet/workflow test`
Expected: all pass (existing suites prove no regression to the non-gated path).

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src
git commit -m "feat(workflow): tool nodes park on policy-gate approval signals"
```

---

### Task 3: interpreter `booleanOutputOf` tool rule

**Files:**
- Modify: `packages/workflow/src/interpreter.ts:612-619`
- Test: `packages/workflow/src/interpreter.test.ts`

**Interfaces:** Produces: a completed tool checkpoint is boolean-true unless `result.policyDenied === true`. (The skip result from Task 2 carries `approved: false` too, which the existing reader already handles — this task makes the TRUE branch work for ordinary tool results that have no `approved` field.)

- [ ] **Step 1: Failing test.** In `interpreter.test.ts`, find an existing `fromOutput` test (grep `fromOutput`) and add: a definition `trigger → tool(t1) → [a via fromOutput:'true', b via fromOutput:'false']`, tool engine stub returns `{ ok: true, result: { id: 1 } }` → expect `a` completed, `b` skipped. And the inverse: engine parks then a deny-skip resolution (or directly seed a completed checkpoint `{ approved: false, policyDenied: true, resolvedBy: 'x' }` via the store) → `b` completed, `a` skipped.

- [ ] **Step 2: Run** `pnpm --filter @valet/workflow test interpreter` — new tests FAIL (both edges dead: `booleanOutputOf` returns undefined for `{ id: 1 }`).

- [ ] **Step 3: Implement.** `booleanOutputOf` needs the node type; the call site (`interpreter.ts:593`) has the source node. Change signature:

```ts
/** `if` → { result: boolean }; `approval` → { approved: boolean };
 * `tool` (policy gates) → boolean-true on any completed result EXCEPT the
 * deny-skip marker { policyDenied: true }. */
function booleanOutputOf(result: unknown, sourceType?: DagNodeType): boolean | undefined {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.result === 'boolean') return r.result;
    if (typeof r.approved === 'boolean') return r.approved;
    if (sourceType === 'tool') return r.policyDenied !== true;
  }
  if (sourceType === 'tool') return true; // completed with a non-object result
  return undefined;
}
```

At the call site pass the source node's `type` (it's resolvable from the definition where the edge's `from` node is looked up — read the surrounding code and pass the type through).

- [ ] **Step 4: Run** `pnpm --filter @valet/workflow test` — all pass.

- [ ] **Step 5: Commit** `git commit -am "feat(workflow): fromOutput edges work on policy-gated tool nodes"`

---

### Task 4: invoker — `requiresApproval` outcome, fail-closed resolver, approval-field honor, dedup exclusion

**Files:**
- Modify: `packages/api/src/plugins/action-invoker.ts`
- Test: `packages/api/src/plugins/action-invoker.test.ts` (extend; it exists — grep its harness first)

**Interfaces:**
- Consumes: Task 1's `WorkflowInvokeActionResult`/`approval` field.
- Produces: `enforceWorkflowPolicy` behavior per spec §1; audit row status `"pending"` on park (Task 5 widens the union).

- [ ] **Step 1: Failing tests** (extend the existing harness — it stubs `db` + plugins):

```ts
it("require_approval with no grant returns requiresApproval and is NOT stored", async () => {
  const res = await invoke(reqFor("linear", "save_issue"));
  expect(res).toEqual({ ok: false, requiresApproval: true, riskLevel: "high", provenance: "risk_default" });
  const rows = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, req.invocationId));
  expect(rows).toHaveLength(0); // dedup table must not replay a gate
});

it("require_approval WITH the approval field executes and stamps resolvedBy", async () => { /* same policy setup + req.approval = { resolvedBy: "u1" } → ok:true; audit row pol:wf:{id} has status "completed" (Task 5 asserts resolvedBy after the column lands) */ });

it("resolver throw returns requiresApproval with provenance resolver_error", async () => { /* make resolveActionPolicy throw (stub db error) → { ok:false, requiresApproval:true, provenance:"resolver_error" }, NOT a failed result */ });

it("resolver_error + approval field executes on the signal's authority", async () => { /* resolver throws AND req.approval set → action executes, ok:true */ });

it("parseStoredResult rejects a stored requiresApproval row", async () => { /* seed a row { ok:false, requiresApproval:true } → invoke throws "corrupt stored result" (defensive: such rows must never exist) */ });
```

- [ ] **Step 2: Run** `pnpm --filter @valet/api test action-invoker` — FAIL.

- [ ] **Step 3: Implement.**

1. `buildActionInvoker` (line 129-134): skip the insert for gate outcomes:

```ts
const result = await computeResult(opts, req, ctx);
if (!result.ok && "requiresApproval" in result && result.requiresApproval) {
  return result; // never persisted: the approved retry must re-reach enforcement
}
```

2. `enforceWorkflowPolicy` (line 307): wrap `resolveActionPolicy` in try/catch. On throw: `console.error` and return `{ ok: false, requiresApproval: true, provenance: "resolver_error" }` — UNLESS `req.approval` is set, in which case return `null` (proceed; the human resolution is the authorization, spec §1). On a clean decision: `deny` unchanged; `require_approval` → if `req.approval` set, treat as allowed (return `null` after the audit write, stamping `status: "approved"` via Task 5's widened union — until Task 5 lands use `"allowed"`); else return `{ ok: false, requiresApproval: true, riskLevel, provenance: decision.provenance.source }`. The park-time `persistInvocationAudit` call writes `status: "pending"` instead of `"denied"` for the requiresApproval path (`deny` keeps `"denied"`).
3. Replace the dead error string at line 354-357 with the structured outcome. Delete `requestDecision`'s "model the gate as an approval node" message (line 529-532) → `"approvals inside workflow tool actions ride the policy gate — this callback is unreachable"` (it stays a rejection; only the copy changes).

- [ ] **Step 4: Run** `pnpm --filter @valet/api test action-invoker` — pass.

- [ ] **Step 5: Commit** `git commit -am "feat(api): workflow policy enforcement returns requiresApproval instead of failing"`

---

### Task 5: audit — widened outcome union + `resolved_by` column

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql` (action_invocations: add `resolved_by text`)
- Modify: `packages/api/src/schema/index.ts` (action_invocations table: `resolvedBy: text("resolved_by")`)
- Modify: `packages/api/src/policies/service.ts:471-504` (`updateInvocationOutcome`)
- Test: `packages/api/src/policies/service.test.ts` (or wherever `updateInvocationOutcome` is tested — grep)

**Interfaces (Produces):**

```ts
export async function updateInvocationOutcome(
  db: AppDb, invocationId: string, orgId: string,
  outcome: {
    status: "completed" | "error" | "approved" | "denied" | "cancelled" | "timeout";
    result?: unknown; error?: string; durationMs?: number; resolvedBy?: string;
  },
): Promise<void>
```

- [ ] **Step 1: Failing test** — stamp `{ status: "approved", resolvedBy: "u1" }` on a seeded row; read back both fields. Second test: `{ status: "timeout" }`.
- [ ] **Step 2: Run** the file's suite — FAIL (type error / missing column).
- [ ] **Step 3: Implement.** Widen the union; in the `.set({...})` add `...(outcome.resolvedBy !== undefined ? { resolvedBy: outcome.resolvedBy } : {})`. SQL: add `resolved_by text` to the `action_invocations` CREATE TABLE in `0000_app.sql` (edit in place — pre-1.0 rule). Then `rm -rf ~/.valet/pg` locally.
- [ ] **Step 4: Run** `pnpm --filter @valet/api test policies` — pass.
- [ ] **Step 5: Commit** `git commit -am "feat(api): audit outcome union + resolved_by for gate resolutions"`

---

### Task 6: resolution service + route hardening + host callbacks

**Files:**
- Modify: `packages/api/src/workflows/service.ts:469-496` (`resolveWorkflowApproval` rework)
- Modify: `packages/api/src/routes/workflows.ts:251-289` (route)
- Modify: `packages/api/src/wire/types.ts:834-846` (`ResolveWorkflowApprovalRequest`)
- Modify: `packages/api/src/workflows/actions.ts:322-350` (`resolve_approval` guards)
- Modify: `packages/api/src/providers/node.ts:364-423` (`onApprovalPending` rework, new `onGateResolved`; pass both to `LocalRunHost`)
- Modify: `packages/api/src/workflows/service.ts` `cancelWorkflowRun` (stamp pending gate audit rows `cancelled`)
- Test: `packages/api/src/routes/workflows.test.ts` + `packages/api/src/workflows/service.test.ts` (grep which exists; follow the real-store harness at `workflows.test.ts:321`)

**Interfaces:**

```ts
// wire/types.ts — REPLACES grantActions:
export interface ResolveWorkflowApprovalRequest {
  approved: boolean;
  note?: string;
  /** Approve scope (policy gates): 'once' (default) authorizes only this
   * invocation; 'run' writes a run-scoped grant for the gated action;
   * 'always' (org admin only) writes a durable org allow policy. Ignored on
   * approval-node gates and on denials. */
  scope?: "once" | "run" | "always";
  /** Foreach-iteration disambiguation; omit or 0 for top-level nodes. */
  iteration?: number;
}

// service.ts:
export type ResolveApprovalOutcome =
  | "ok" | "not_found" | "not_parked" | "already_resolved" | "timed_out"
  | "forbidden_always" | "org_mismatch" | "human_only";

export async function resolveWorkflowApproval(
  deps: WorkflowServiceDeps, owner: WorkflowOwner,
  input: { runId: string; nodeId: string; approved: boolean; note?: string;
           scope?: "once" | "run" | "always"; iteration?: number;
           via: "web" | "agent" },
): Promise<ResolveApprovalOutcome>
```

- [ ] **Step 1: Failing tests.** Follow `workflows.test.ts:321`'s pattern (real store, run seeded directly). Cases — each asserts the HTTP status AND that nothing was written (no signal, no grant row) on the failure paths:

1. Resolve a run that is NOT parked on the gate → 409 `Run is not waiting on this gate.` (this kills pre-approval).
2. Park a run on `approval:t1` (seed via `store.parkRun`), resolve once → 200; resolve again before consumption → 409 `This gate was already resolved.`
3. Parked with `waitingOn[0].timeoutAt` in the past → 409 `Gate timed out.`
4. Tool gate + `scope: "run"` → 200 and a `runtime_grants` row with `workflowExecutionId === runId`, `policyKey === "linear.save_issue"` (server-derived from the parked node's definition, qualified fqid).
5. Tool gate + `scope: "always"` as non-admin → 403, error text contains `Ask an org admin`; no policy row, no grant, no signal.
6. `scope: "always"` as admin → 200; `action_policies` row `pol:approval:{orgId}:linear.save_issue` AND the run grant from case 4 both exist.
7. Foreach body gate: park on `approval:body1:3`, resolve with `iteration: 3` → 200, signal `approval:body1:3:resolution` inserted; the node lookup found `body1` inside the foreach's `body` (not in `definition.nodes`).
8. Run's defining org ≠ caller org → 403 (`org_mismatch`).
9. Body without `approved` boolean → 400 (existing behavior, keep).
10. `grantActions` in the body → 400 `grantActions is no longer accepted. Use scope instead.`
11. Audit stamp: after case 4's approve, `action_invocations` row `pol:wf:workflow:{runId}:t1` has `status: "approved"`, `resolvedBy` = caller.
12. Agent action: `workflows.resolve_approval` against a TOOL-node gate → failure result whose error contains `A human must resolve this gate` (`human_only`); against an approval-node gate it still works.
13. `cancelWorkflowRun` on a run parked on a tool gate → the `pol:wf:...` row stamps `status: "cancelled"`.

- [ ] **Step 2: Run** `pnpm --filter @valet/api test workflows` — new cases FAIL.

- [ ] **Step 3: Implement `resolveWorkflowApproval`.** Order is normative (spec §4: authz → writes → signal):

```ts
const run = await ownedRun(deps, owner, input.runId);
if (!run) return "not_found";
const iter = input.iteration ?? 0;
const suffix = iter > 0 ? `:${iter}` : "";
const signalType = `approval:${input.nodeId}${suffix}`;

const wait = run.status === "parked"
  ? run.waitingOn.find((w) => w.kind === "signal" && w.signalType === signalType)
  : undefined;
if (!wait || wait.kind !== "signal") return "not_parked";
if (wait.timeoutAt !== undefined && Date.now() >= wait.timeoutAt) return "timed_out";

const existing = await deps.workflowStore.listSignals(input.runId, { unconsumed: true });
if (existing.some((s) => s.signalType === signalType)) return "already_resolved";

const node = findNodeInDefinition(run.definition, input.nodeId); // searches nodes + foreach bodies
const isPolicyGate = node?.type === "tool";
if (isPolicyGate && input.via === "agent") return "human_only";

// Org comes from the RUN's defining workflow, never the caller's session.
const orgId = await definitionOrgId(deps.db, run.params.workflowId);   // same lookup onApprovalGrant uses (providers/node.ts:403)
if (orgId === null || !(await isOrgMember(deps.db, orgId, owner.userId))) return "org_mismatch";

if (input.approved && isPolicyGate && node.type === "tool") {
  const actionId = node.action.includes(".") ? node.action : `${node.service}.${node.action}`;
  const now = Date.now();
  if (input.scope === "always") {
    try { await writeAlwaysAllowPolicy(deps.db, { orgId, actionId, grantedBy: owner.userId, now }); }
    catch (err) { if (err instanceof AlwaysAllowNotAdminError) return "forbidden_always"; throw err; }
  }
  if (input.scope === "always" || input.scope === "run") {
    await writeExecutionGrant(deps.db, input.runId, { orgId, service: node.service, actionId, grantedBy: owner.userId, now });
  }
}

await deps.workflowStore.insertSignal({
  runId: input.runId,
  signalId: `approval:${input.nodeId}${suffix}:resolution`,
  signalType,
  payload: { approved: input.approved, resolvedBy: owner.userId, note: input.note,
             scope: input.scope, resolvedVia: input.via },
  createdAt: Date.now(),
});
if (isPolicyGate) {
  await updateInvocationOutcome(deps.db, `pol:wf:workflow:${input.runId}:${input.nodeId}${suffix}`, orgId,
    { status: input.approved ? "approved" : "denied", resolvedBy: owner.userId });
}
await deps.workflowRunHost.wake(input.runId);
return "ok";
```

`findNodeInDefinition(definition, nodeId)`: narrow `definition` at runtime (same defensive style as `findApprovalPrompt`, `run-detail-helpers.ts:45`): scan `nodes`; for each `type === "foreach"` node also compare `node.body.id`. Return the matched node object (typed via narrowing, no casts). `isOrgMember`: grep `packages/api/src/services/org.ts` — reuse the existing membership helper next to `isOrgAdmin` (it exists for org routes; if the exact name differs, use what's there).

Route: map outcomes — `not_found` → 404 `{ error: "run not found" }`; `not_parked` → 409 `{ error: "Run is not waiting on this gate." }`; `already_resolved` → 409 `{ error: "This gate was already resolved. Refresh the run page." }`; `timed_out` → 409 `{ error: "Gate timed out." }`; `forbidden_always` → 403 `{ error: "Always allow requires an org admin. Ask an org admin, or approve for the rest of this run." }`; `org_mismatch` → 403 `{ error: "You are not a member of this run's organization." }`; `human_only` cannot surface via HTTP (route passes `via: "web"`). Validate `scope` ∈ {once,run,always} and `iteration` is a non-negative integer (else 400). Reject a `grantActions` key explicitly with the 400 from test 10.

`actions.ts` `resolve_approval`: pass `via: "agent"`; map `human_only` → `{ success: false, error: "A human must resolve this policy gate from the run page: /workflows/runs/{run_id}" }`. Add the tool-node self-invocation guard: `if (ctx.sessionId.startsWith("wf:invoke:")) return { success: false, error: "A workflow cannot resolve approval gates. A human must resolve this gate from the run page." };` — apply the same guard to `cancel_run`.

`providers/node.ts` `onApprovalPending`: title `info.summary ?? info.prompt ?? \`Approval needed: ${info.service}.${info.action}\``; body for policy gates: `\`Workflow run ${info.runId} is paused on ${info.nodeId}.\``; `dedupeKey: \`${info.runId}:${info.nodeId}${info.iteration !== undefined ? \`:${info.iteration}\` : ""}\`` (iteration in the key — iteration 2+ must notify). New `onGateResolved` impl: resolve orgId via the same definition lookup, then `updateInvocationOutcome(db, \`pol:wf:workflow:${info.runId}:${info.nodeId}${info.iteration > 0 ? \`:${info.iteration}\` : ""}\`, orgId, { status: info.outcome, resolvedBy: info.resolvedBy })` in a try/catch (best-effort). Pass it to `new LocalRunHost({...})`.

`cancelWorkflowRun`: after `terminate`, stamp: select `pol:wf:` rows for this run still `status = 'pending'` → `updateInvocationOutcome(..., { status: "cancelled" })` (org from the definition lookup; skip silently when null).

- [ ] **Step 4: Run** `pnpm --filter @valet/api test workflows` — pass. Also `pnpm --filter @valet/api test` (route/wire changes ripple).

- [ ] **Step 5: Commit** `git commit -am "feat(api): harden workflow approval resolution with scopes"`

---

### Task 7: run-detail wire — `pendingGates[]` + `needsApproval`

**Files:**
- Modify: `packages/api/src/wire/types.ts:776-832`
- Modify: `packages/api/src/workflows/service.ts:412-446` (`listWorkflowRuns`), `:499-541` (`getWorkflowRunDetail`)
- Test: `packages/api/src/workflows/service.test.ts` (or route test file — same harness as Task 6)

**Interfaces (Produces):**

```ts
export interface WorkflowPendingGate {
  nodeId: string;
  kind: "approval" | "policy_gate";
  iteration?: number;
  prompt?: string;              // approval nodes
  service?: string;             // policy gates
  action?: string;
  riskLevel?: string;
  provenance?: string;
  gateParams?: unknown;
  gateParamsTruncated?: boolean;
  gateItem?: unknown;
  timeoutAt?: number;
  onDeny?: "fail" | "skip";
}
// WorkflowRunDetail gains: pendingGates: WorkflowPendingGate[];
// WorkflowRunSummary gains: needsApproval?: boolean;
```

- [ ] **Step 1: Failing tests.** (a) Seed a run parked on `approval:t1` with an intent checkpoint carrying gate effects (`gate: true, gateParams: {...}, riskLevel: "high", timeoutAt: 123`) and a definition whose `t1` is a tool node with `onDeny: "skip"` → `getWorkflowRunDetail` returns one `pendingGates` entry with every field populated and `kind: "policy_gate"`; assert `gateParams` round-trips VERBATIM (the exact object, not `toBeDefined()`). (b) An approval-node park → `kind: "approval"`, `prompt` from the definition, no gate effects fields. (c) `listWorkflowRuns` marks that run `needsApproval: true` and a timer-parked run `false`. (d) The checkpoint wire does NOT grow an `effects` field (assert absent — selective exposure only).

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** In `getWorkflowRunDetail`, after fetching checkpoints: for each `run.waitingOn` entry with `kind === "signal"` and `signalType.startsWith("approval:")`: derive `iteration` from the suffix (split the part after `approval:{nodeId}`; the checkpoint key is `(nodeId, iteration)`), find the matching intent checkpoint, find the node via `findNodeInDefinition` (export it from Task 6), and build the entry: tool node → `kind: "policy_gate"`, `service`/`action`/`onDeny` from the definition, `gateParams`/`gateParamsTruncated`/`gateItem`/`riskLevel`/`provenance`/`timeoutAt` from `cp.effects` (typeof-narrowed reads, never a cast); approval node → `kind: "approval"`, `prompt` from the node. `listWorkflowRuns`: `needsApproval: run.status === "parked" && run.waitingOn.some((w) => w.kind === "signal" && w.signalType.startsWith("approval:"))`.

- [ ] **Step 4: Run** — pass. `pnpm typecheck`.

- [ ] **Step 5: Commit** `git commit -am "feat(api): pendingGates + needsApproval on the workflow run wire"`

---

### Task 8: web helpers — `findPendingGates`, `RunStatusChip`, `RiskBadge`

**Files:**
- Modify: `packages/web/src/components/workflows/run-detail-helpers.ts`
- Create: `packages/web/src/components/workflows/run-status-chip.tsx`
- Create: `packages/web/src/components/workflows/risk-badge.tsx`
- Test: `packages/web/src/components/workflows/run-detail-helpers.test.ts` (extend)

**Interfaces (Produces):**

```ts
// run-detail-helpers.ts — findPendingApproval STAYS (approval cards use it);
// new, consumed by Task 9:
export interface PendingGateLike extends /* wire */ WorkflowPendingGate {}
export function runNeedsApproval(run: { status: string }, pendingGates: WorkflowPendingGate[] | undefined): boolean;

// run-status-chip.tsx
export function RunStatusChip(props: { status: WorkflowRunStatus; outcome?: WorkflowRunOutcome; needsApproval: boolean }): JSX.Element;
// mapping: needsApproval → amber "Needs approval" (bg-amber-500/15 text-amber-700 dark:text-amber-300, static h-2 w-2 amber dot);
// parked otherwise → neutral "Waiting"; running/pending → moss "Running";
// settled → existing outcome Badge (OUTCOME_VARIANT moves here from the route file).

// risk-badge.tsx
export function RiskBadge(props: { level: string }): JSX.Element;
// low → bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300
// medium → bg-amber-500/15 text-amber-700 dark:text-amber-400
// high → bg-orange-500/15 text-orange-700 dark:text-orange-400
// critical → bg-danger-500/15 text-danger-600 dark:text-danger-500
// unknown level → neutral. Shape: rounded-sm px-1.5 py-0.5 text-[11px] font-medium.
```

- [ ] **Step 1: Failing tests** for `runNeedsApproval` (true only when parked AND ≥1 gate) and `statusByNodeId` unchanged-behavior guard. Component render tests follow the repo's existing component-test idiom (see `approval-card.test.tsx`): `RunStatusChip` renders "Needs approval" when flagged, the outcome badge when settled; `RiskBadge` maps `high` → text `high` with the orange class.
- [ ] **Step 2: Run** `pnpm --filter @valet/web test run-detail-helpers` (and the new component test files) — FAIL.
- [ ] **Step 3: Implement** per the interfaces above. Keep helpers pure; the chip/badge take props only.
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Commit** `git commit -am "feat(web): run status chip, risk badge, pending-gate helpers"`

---

### Task 9: web — `PolicyGateCard` + run page integration

**Files:**
- Create: `packages/web/src/components/workflows/policy-gate-card.tsx`
- Create: `packages/web/src/components/workflows/policy-gate-card.test.tsx`
- Modify: `packages/web/src/routes/workflows.runs.$runId.tsx` (render all gates; use `RunStatusChip`)
- Modify: `packages/web/src/api/workflows.ts:166-178` (`useResolveApproval` — refetch on error too)
- Modify: `packages/web/src/routes/workflows.$workflowId.tsx` (RunsDrawer pill: amber "needs approval" via `needsApproval`)
- Modify: `packages/web/src/routes/-workflows.runs.$runId.test.tsx` (extend)

**Interfaces:**
- Consumes: `WorkflowPendingGate` (Task 7 wire), `useResolveApproval` (body now carries `scope`/`iteration`), `useMe` admin pattern from `decision-gate-card.tsx:39-40` (`meQ.data?.orgRole === "admin"`, fails closed while loading), `RiskBadge`, existing `DropdownMenu` primitive.

```ts
export interface PolicyGateCardProps {
  runId: string;
  gate: WorkflowPendingGate; // kind === "policy_gate"
}
export function PolicyGateCard(props: PolicyGateCardProps): JSX.Element;
```

- [ ] **Step 1: Failing tests** (msw/fetch-stub idiom from `approval-card.test.tsx` + `decision-gate-card.test.tsx`):

1. Renders `service.action` mono, `RiskBadge`, params in a `<details>`; truncation notice when `gateParamsTruncated`.
2. "Approve once" POSTs `{ approved: true, scope: "once", note: undefined, iteration: gate.iteration }`.
3. Dropdown "Approve for rest of run" POSTs `scope: "run"`; its sublabel names the action (`Covers every later call to linear.save_issue in this run.`).
4. Non-admin: "Always allow" item disabled with "(org admin only)" suffix; admin: enabled, and clicking opens the confirm step naming the blast radius (`Allows linear.save_issue for every user and run in this org.`) with a link to `/settings/organization` policies — confirm then POSTs `scope: "always"`.
5. Deny is a separate danger button; microcopy switches on `gate.onDeny` ("Denying fails this node." / "Denying skips this node; downstream nodes can branch on the denial.").
6. Mutation 409 → renders "This gate was already resolved. Refreshing…"; other error → the server's `error` string verbatim.
7. `provenance === "resolver_error"` → renders "Policy check failed — approval requested as a safe fallback."
8. `timeoutAt` set → footer shows "times out" text; `gate.iteration` → "Iteration 4".

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Amber card (`rounded-md border border-amber-300 bg-amber-50/70 dark:border-amber-700/60 dark:bg-amber-950/40 p-4 space-y-3`), header per the spec §5 wireframe. Split-button: primary `Button` "Approve once" with `rounded-r-none`, sibling `DropdownMenu` trigger `Button` with `ChevronDown` only, `rounded-l-none border-l border-white/25`; menu items carry `text-xs text-muted` sublabels. Deny: separate `variant="danger"` `Button` with a `gap-4` between. Note `Input` above the buttons; the note rides whichever action fires. Busy state disables all and spinners the pressed one (copy `decision-gate-card`'s pattern). On mutation error, if the message matches the 409 copy, also `qc.invalidateQueries({ queryKey: qkWorkflows.run(runId) })` — implement by extending `useResolveApproval` with an `onError` invalidate (5s poll makes stale cards otherwise). Route integration: replace the single `findPendingApproval` card block (`workflows.runs.$runId.tsx:78-110`) — `data.pendingGates` renders `ApprovalCard` for `kind === "approval"` (prompt from the entry now) and `PolicyGateCard` per `kind === "policy_gate"` entry, ALL of them; header uses `RunStatusChip` with `runNeedsApproval(run, data.pendingGates)`. Checkpoint rows: when a completed tool checkpoint's result has `policyDenied === true`, render a "Denied by {resolvedBy}" line in `text-danger-500`, never the green success treatment. RunsDrawer pill: `r.needsApproval ? <amber pill "needs approval"> : (r.outcome ?? r.status)`.

- [ ] **Step 4: Run** `pnpm --filter @valet/web test policy-gate-card` + the route test + `pnpm --filter @valet/web test` — pass.

- [ ] **Step 5: Commit** `git commit -am "feat(web): policy gate card with approval scopes on the run page"`

---

### Task 10: web — `ServiceActionCombobox` + both policy forms

**Files:**
- Create: `packages/web/src/components/settings/service-action-combobox.tsx`
- Create: `packages/web/src/components/settings/service-action-combobox.test.tsx`
- Modify: `packages/web/src/components/settings/policy-overrides-section.tsx:126-147`
- Modify: `packages/web/src/components/settings/policies-section.tsx:358-394`

**Interfaces:**
- Consumes: `usePlugins()` (`~/api/integrations:26`, returns `ListPluginsResponse` with `PluginSummary[]` — `services[].service`, `services[].actions[]` `{ fqid, name?, riskLevel }`, wire/types.ts:912), `RiskBadge` (Task 8), `Input`/`Badge`/`Spinner` primitives. No new dependency — hand-rolled listbox, NOT Radix DropdownMenu (focus trap kills typing) and NOT a new Popover package.

```ts
export interface ComboItem { id: string; label: string; sublabel?: string; badge?: ReactNode }
export function ServiceActionCombobox(props: {
  mode: "service" | "action";
  value: string;
  onChange: (v: string) => void;
  id?: string;             // htmlFor pairing
  placeholder?: string;
}): JSX.Element;
```

- [ ] **Step 1: Failing tests:**

1. Focus opens the FULL list (parity with the `<select>` it replaces); typing `lin` filters to matching label/id, case-insensitive.
2. Service mode rows: display name + mono id + `Badge` "{n} actions". Action mode rows: name + mono fqid + `RiskBadge` (flat list, service in each row — no cascade; the target model is one-of).
3. ArrowDown/ArrowUp move `aria-activedescendant`; Enter selects the highlight and calls `onChange`; Escape closes without committing.
4. Free text: query matching nothing shows the pinned row `Use "zzz" — not in the installed catalog`; Enter (or blur) commits `zzz` via `onChange`.
5. ARIA: input has `role="combobox"`, `aria-expanded`, `aria-controls`; rows `role="option"` + `aria-selected`.
6. Loading: `usePlugins` pending → spinner row "Loading catalog…"; typed free text still committable.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Port v1's `TypeaheadCombobox` mechanics (`packages/client/src/components/settings/action-policy-dialog.tsx:130-384` — read it first: mousedown-preventDefault selection, click-outside commit, highlight `scrollIntoView({ block: "nearest" })`, highlight reset to 0 on filter change), restyled to v2 tokens: listbox `absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-md border border-line bg-paper shadow-lg`, highlighted row `bg-ink-wash`. Derive items inside the component from `usePlugins()`: service mode dedupes `services[].service` with action counts; action mode flattens every action to `{ id: fqid, label: name ?? fqid, sublabel: fqid, badge: <RiskBadge level={riskLevel}/> }`. Empty state row: `No matches for "{q}". Press Enter to use it as a literal id.` Wire in: `policy-overrides-section.tsx` — replace the service `Input` (line 129) and action `Input` (line 141) with `<ServiceActionCombobox mode="service" .../>` / `mode="action"` (keep the `Label`s and ids); `policies-section.tsx` — replace both `<select>`s the same way (risk-level select stays).

- [ ] **Step 4: Run** `pnpm --filter @valet/web test service-action-combobox` + both section test files (extend their existing tests if the select swap breaks them) + `pnpm --filter @valet/web test` — pass.

- [ ] **Step 5: Commit** `git commit -am "feat(web): service/action typeahead on both policy forms"`

---

### Task 11: full validation

- [ ] **Step 1:** `pnpm typecheck` — clean.
- [ ] **Step 2:** Targeted regression sweeps: `pnpm --filter @valet/workflow test`, `pnpm --filter @valet/api test`, `pnpm --filter @valet/web test`, `pnpm --filter @valet/engine test happy-path`, `pnpm --filter @valet/store-postgres test` — all green.
- [ ] **Step 3:** `rm -rf ~/.valet/pg` (Task 5 edited `0000_app.sql` in place), then `make e2e`. THE validation: clean scorecard; any red row must be a named pre-existing environmental failure, re-run Docker rows in isolation before believing them (`make e2e E2E_ARGS="--only <suite-id>"`).
- [ ] **Step 4:** Update the spec's status line to "implemented" and note any deviations in a Deviations section; commit `docs: mark workflow approval UX spec implemented`.

## Self-review notes (already applied)

- Spec §1-§4 → Tasks 1-6; §5 → Tasks 7-9; §6 → Task 10; §7/testing → interwoven + Task 11.
- `once` scope: no grant write anywhere — Task 6 writes grants only for `run`/`always`; Task 2 carries the signal into the request; Task 4 honors it. Consistent.
- Signal strings: `approval:{nodeId}{suffix}` / `...:resolution` used identically in Tasks 2, 6, 7.
- Audit invocation id: `pol:wf:workflow:{runId}:{nodeId}{suffix}` in Tasks 6 (route/cancel) matches the invoker's `pol:wf:{invocationId}` with `invocationId = workflow:{runId}:{nodeId}{suffix}` (tool.ts mint). Consistent.
- `booleanOutputOf` extension (Task 3) matches the skip result shape written in Task 2 (`approved: false` + `policyDenied: true`).
