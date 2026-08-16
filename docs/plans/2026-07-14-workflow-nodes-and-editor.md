# Workflow Node Completion + Visual Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the dag/v1 node vocabulary on the v2 interpreter — `foreach`, `llm`, `orchestrator`, `tool` — and replace the JSON-textarea authoring experience with a real visual editor (React Flow canvas, node palette, inspector forms, validation, persisted layout) in `packages/web`.

**Architecture:** Part A extends `packages/workflow`: four new node types + validator rules, an executor-interface extension for iterations/aliases (unlocking foreach), three new `WorkflowEngineDeps` seams (`llmComplete`, `promptOrchestrator`, `invokeAction`) implemented in `packages/api` (pi-ai, the Phase 4 orchestrator wake path, and a Phase-6-activated action stub respectively). Part B rebuilds the visual editor in `packages/web`: main's pure `workflow-editor-model.ts` is lifted and trimmed to the v2 node set; the presentation layer is written fresh on `@xyflow/react` 12 in the calm-companion system.

**Tech Stack:** TypeScript, Node 22, `@sinclair/typebox`/typebox, `@mariozechner/pi-ai` (completeSimple/getModel), `@xyflow/react` ^12, Vite/React 19 + TanStack Router/Query, vitest + testing-library.

**Source material (read via `git show main:<path>` — main is the semantic reference, v2 durability model governs):** node shapes `packages/shared/src/types/workflow-dag/nodes/{foreach,llm,orchestrator,tool}.ts`; executor semantics `packages/worker/src/workflows/nodes/{foreach,llm,orchestrator,tool}.ts`; editor model `packages/client/src/components/workflows/workflow-editor-model.ts` (+ its test); editor presentation `visual-workflow-editor.tsx` (REFERENCE ONLY — do not port; it's bound to legacy ai-elements/ui components). v2 ground truth: `packages/workflow/src/` (interpreter, store contract JSDoc, existing executors), `docs/specs/2026-07-11-workflow-run-host-design.md`, Phase 5 plan `docs/plans/2026-07-13-engine-v2-phase-5-workflows.md` (its Locked Decisions still bind where not superseded here).

## Global Constraints

- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md).
- All Phase-5 durability invariants hold for the new executors: intent-before-external-dispatch, deterministic idempotency keys, attempt-fenced writes, effects read-back on resume (never re-mint), parking executors re-enterable, spurious wakes harmless.
- `packages/workflow` stays portable (no Node-only APIs outside local-host; clock injected).
- Node 22 (`source ~/.nvm/nvm.sh && nvm use`); `pnpm rebuild better-sqlite3` on NODE_MODULE_VERSION errors. Pre-existing flaky `packages/api/src/routes/messages.abort.test.ts` — ignore its failures.
- Gates before every commit claim: `pnpm --filter @valet/workflow test`, plus the suites of any other touched package, plus root `pnpm typecheck` (sanctioned pre-existing failure: `packages/worker/src/integrations/packages.ts`).
- OUT of scope: tool-node policy gates / approval holds / retries / `action_invocations` audit rows (Phase 6 lands the plugin system + policy; the seam here is deliberately thin), webhook/schedule triggers, workflow copilot, version history, run-detail graph overlay (checkpoint list stays), main's cumulative 5000-iteration cap (per-node `maxItems` only; note in foreach JSDoc).

## Locked Design Decisions

1. **New node shapes (lifted from main, trimmed):**
   - `ForeachNode { id, type:'foreach', items: string, body: ForeachBodyNode, maxItems?, concurrency?, itemAlias?, indexAlias?, onItemError?: 'fail'|'skip'|'collect' }`; `ForeachBodyNode = LlmNode | ToolNode | SetNode | OrchestratorNode | SessionNode` (v2 drops `stop` from bodies — stopping a run from inside a loop iteration interacts badly with the wave model; validator rejects it).
   - `LlmNode { id, type:'llm', model: string, system?, prompt: string, outputSchema?, temperature?, maxOutputTokens? }` — `model` REQUIRED in v2 (main threw at runtime; we reject at validation).
   - `OrchestratorNode { id, type:'orchestrator', prompt: string, outputSchema?, wait?: { mode:'none'|'until_idle' } }` — drops main's `forceNewThread`/`repairModel`/`resultMode`/`wait.timeout` (same trims as the session node).
   - `ToolNode { id, type:'tool', service: string, action: string, params: Record<string,unknown>, summary? }` — drops `onPolicyDeny`/`retries` (Phase 6 re-adds with policy).
2. **Validator additions:** foreach `items` non-empty + body is an allowed type + body id unique against definition node ids + `maxItems`/`concurrency` positive ints (concurrency ≤ 10); llm `model` + `prompt` non-empty; orchestrator `prompt` non-empty; tool `service`+`action` non-empty; **session `wait.timeout` now REJECTED** ("not implemented — omit it"; closes the Phase-5 accept-with-note). `WorkflowDefinition` regains `ui?: WorkflowEditorState` (positions + viewport, lifted from main's shape.ts) — ignored by interpreter and validator (structural tolerance only).
3. **Deps seams (added to `WorkflowEngineDeps` in `packages/workflow/src/engine-deps.ts`):**
   - `llmComplete(req: { model: string; system?: string; prompt: string; temperature?: number; maxOutputTokens?: number }): Promise<{ text: string }>` — api impl over pi-ai `getModel` + `completeSimple` (same imports `packages/engine/src/compaction.ts` uses). At-least-once per the run-host spec (no receiver dedup): intent narrows the duplicate window, one duplicate billed call on crash is the accepted cost.
   - `promptOrchestrator(prompt: string, opts: { dispatchId: string; queueMode: 'followup'; ownerHint: { ownerType: string; ownerId: string } }): Promise<{ sessionId: string; threadId: string; queueItemId: string }>` — api impl resolves the owner's orchestrator via the Phase 4 `EngineHost` orchestrator path and submits the prompt as a SignalContent envelope (`signalType: 'workflow.request'`, body = rendered prompt) with the given dispatchId; `queueMode 'followup'` always (internal signals must never steer-abort the assistant's live turn — Phase 4 rule). `awaitResult`/`abort`/`isSettled` reuse the existing deps methods (they're session-agnostic).
   - `invokeAction(req: { service: string; action: string; params: Record<string,unknown>; invocationId: string }): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>` — api impl this phase is a stub returning `{ ok: false, error: 'no integrations are connected — the plugin system lands in Phase 6' }`; the seam contract (deterministic `invocationId`, dedup-capable receiver MUST return the original result for a duplicate id) is documented in the interface JSDoc for the Phase 6 implementer.
4. **llm executor:** intent (effects: none needed — no receiver handle) → render prompt/system over `{trigger, nodes}` (+aliases) → `llmComplete` → if `outputSchema`: extract/validate via `extractStructuredOutput` from `@valet/engine` (same fence-or-whole-text rules as the session node); ONE bounded repair (re-call `llmComplete` with the schema + validation error appended to the prompt; track `repairAttempted` in intent effects) → completed result `{ text, output? }` (output only when schema set and valid); second failure → node failed. `maxOutputTokens` clamped to 16_384 (main's ceiling, same rationale minus the CF step limit — keep as an output-size sanity bound); result JSON > 512KB → node failed with a descriptive error.
5. **orchestrator executor:** mirrors the session executor's shape with `promptOrchestrator` in place of createSession+prompt: intent → dispatch (dispatchId `workflow:{runId}:{nodeId}[:{iteration}]`) → persist receipt in effects (equal-attempt overwrite) → `wait.mode 'none'` completes with `{ receipt }` else park on submission → wake: isSettled probe → awaitResult w/ resultSchema → same outcome mapping and ONE repair round as the session node (repair prompt goes through `promptOrchestrator` with `:repair` suffix). Extract the session executor's shared machinery (result mapping + repair bookkeeping + receipt-persist flow) into a helper module both executors use — refactor, don't duplicate; the session executor's existing tests must stay green unchanged.
6. **tool executor:** intent (effects: `{ invocationId }`) → `invokeAction` with `invocationId = 'workflow:{runId}:{nodeId}[:{iteration}]'` → `{ok:true}` → completed with `result`; `{ok:false}` → node failed with the error. Re-entry with intent re-invokes with the SAME invocationId (receiver-side dedup is the contract; the stub is trivially idempotent).
7. **Executor-interface iteration/alias support:** `NodeExecutorArgs` gains `iteration: number` (default 0) and `aliases?: Record<string, unknown>` merged into the template context by the shared context builder. All existing executors thread `iteration` through their checkpoint writes instead of the hardcoded 0 and append `[:{iteration}]` (iteration > 0 only) to their dispatchIds/invocationIds/session ids — closing the Phase-5 "dispatchId omits iteration" minor. Existing tests must pass unchanged (iteration defaults to 0 → identical ids).
8. **foreach executor:** items = template-resolve `node.items` (must be an array; else node failed); truncate to `maxItems` (default 100), record `truncatedCount`. Per item i: invoke the registry executor for `body.type` with `iteration: i`, `aliases: { [itemAlias ?? 'item']: items[i], [indexAlias ?? 'index']: i }`, checkpoints keyed `(runId, body.id, i)` (the body id is not in `definition.nodes`, so the wave loop never sees these rows — the foreach owns them). Body executors that park bubble their `waitingOn` entries up through the foreach's parked result; on re-drive the foreach skips iterations with terminal body checkpoints and re-enters intent-holding ones. Concurrency window = `concurrency` (default 1): keep up to N iterations in flight (dispatched-and-parked counts as in flight). `onItemError`: 'fail' (default) → first failed iteration fails the foreach (remaining un-started iterations are not started; in-flight parked ones are aborted by the foreach itself (best-effort `engine.abort` over their persisted receipts) before it returns failed); 'skip'/'collect' → record per-item status and continue. Aggregate iteration-0 checkpoint result = main's `ForeachResult` shape `{ items: [{status, data?, error?}], count, inputCount, truncatedCount, completedCount, skippedCount, failedCount }`; foreach node status: completed unless onItemError 'fail' tripped (then failed). Foreach itself is never a body (validator).
9. **Editor model (`packages/web/src/components/workflows/editor-model.ts`):** lift main's `workflow-editor-model.ts` + its test, trimmed to the v2 node set and v2 `WorkflowDefinition` (no NODE_DOCS dependency — v2 keeps a small local `NODE_META: Record<DagNodeType, { label, description, defaultNode(id) }>`). Keep: definition↔flow conversion (nodes/edges with `fromOutput` handles on if/approval sources), add/remove/duplicate node, connect rules (single trigger root, no self-edges, fromOutput only from if/approval), position persistence into `definition.ui.nodes[id].position`, viewport into `definition.ui.viewport`, id generation (slugified unique). The editor model stays a set of pure definition-in/definition-out functions; the editor component holds the definition and the dirty flag in React state. Auto-layout for definitions without `ui`: BFS-depth layered layout (column = depth, row = index within depth; 260×120 spacing) — no dagre/elk dependency.
10. **Editor presentation (`packages/web/src/components/workflows/editor/`):** `@xyflow/react` ^12 (new dep in packages/web). Custom node component in calm-companion tokens (paper card, line border, moss accent for the selected node, node-type label + summary line, amber badge for validation errors on that node); if/approval sources render two labeled source handles (true/false); default edge with `when`-condition badge when set. Palette: a left rail of "add node" buttons (one per addable type — everything except trigger). Inspector: right panel editing the selected node's fields — per-type forms (session: prompt/title/model/outputSchema-as-JSON-textarea/wait-mode; llm: model/system/prompt/schema/temperature/maxTokens; approval: prompt/summary/details/timeout/onDeny; wait: duration; if: condition fields per the v2 `IfNode` shape (read `packages/workflow/src/dag/nodes.ts` for the exact condition structure and mirror main's inspector fields for it); set: key/value template rows; foreach: items/aliases/maxItems/concurrency/onItemError + a nested body sub-form (body type selector + that type's form, reusing the same field components); tool: service/action/params-JSON/summary; stop: outcome; trigger: read-only). Edge selection edits `when` + `fromOutput`. Validation: run `validate()` from `@valet/workflow` on every change; banner lists errors; nodes named in errors get the amber badge. Save = PUT with the full definition (including `ui`); unsaved-changes indicator; Cancel-discard.
11. **Routes restructure:** `/workflows` index keeps the list (name, run count, Run button) but each definition links to `/workflows/$workflowId` — the editor page (canvas + inspector + Save + Run + runs list in a collapsible footer or side section). The JSON textarea remains as an "Edit JSON" toggle on the editor page (switching modes round-trips through the same definition state; JSON mode is the escape hatch and the create-form default stays JSON-free: "New workflow" now creates a minimal `trigger → stop` definition immediately and navigates to the editor). `/workflows/runs/$runId` unchanged.
12. **Editor testing:** the lifted model gets its (adapted) unit tests — conversion round-trip incl. `ui` positions, connect rules, add/remove, fromOutput handles. Presentation gets focused component tests: palette click adds a node to the model; inspector field edit updates the definition; validation banner appears for a broken definition; Save fires PUT with the edited definition. jsdom needs a `ResizeObserver` mock for xyflow — add to test setup if absent. Full-canvas interaction (drag/connect gestures) is NOT unit-tested — covered by the manual dogfood.
13. **Dogfood definition (final task, manual + browser):** build IN THE EDITOR: trigger → llm (haiku, extract a JSON list) → foreach (items from the llm output, body = set computing a derived value, concurrency 2) → orchestrator (`wait: until_idle`, ask the assistant to summarize the foreach output) → approval → stop; plus a second tiny workflow with a tool node to see the stub's clean failure. Verify: editor authoring end-to-end (palette, inspector, edge conditions, validation, save), run completes, foreach aggregate visible in run detail, orchestrator turn shows up in the assistant's chat as a signal, approval via bell.

---

### Task 1: dag types + validator for the four node types (+ `ui` re-add, session-timeout rejection)

**Files:** modify `packages/workflow/src/dag/nodes.ts`, `src/dag/shape.ts` (re-add `WorkflowEditorState`/`ui`), `src/dag/validate.ts`; tests `src/dag/validate.test.ts`.
**Covers:** decisions 1–2. Lift shapes via `git show main:packages/shared/src/types/workflow-dag/nodes/{foreach,llm,orchestrator,tool}.ts` (interfaces only, apply the trims). Validator tests for every new rule incl. foreach-body restrictions (foreach/if/approval/stop rejected as bodies; body id collision), llm model-required, session wait.timeout rejection, `ui` tolerated.

### Task 2: deps seams (interfaces) + executor iteration/alias support

**Files:** modify `packages/workflow/src/engine-deps.ts` (decision 3 signatures + JSDoc contracts), `src/nodes/index.ts` (NodeExecutorArgs: `iteration`, `aliases`), the shared template-context builder, and all five existing executors (thread `iteration` into checkpoint writes and id suffixes per decision 7); tests: extend existing executor tests with one iteration>0 case each (ids gain the suffix; checkpoint rows keyed at the iteration) — all existing tests pass UNCHANGED otherwise.
**Interfaces produced:** exactly decision 3's three methods + decision 7's args — Tasks 3–8 consume them verbatim.

### Task 3: llm executor

**Files:** create `packages/workflow/src/nodes/llm.ts`; register; tests `src/nodes/llm.test.ts` (scripted fake `llmComplete`).
**Covers:** decision 4. Tests: happy path text-only; schema valid → output; schema invalid → ONE repair call (prompt contains schema + error) → valid → completed; double failure → node failed; maxOutputTokens clamp; oversized result → failed; crash-after-intent re-drive re-calls llmComplete (at-least-once documented; call count 2 tolerated in that test only).

### Task 4: tool executor

**Files:** create `packages/workflow/src/nodes/tool.ts`; register; tests (fake `invokeAction` recording invocationIds).
**Covers:** decision 6. Tests: params template-rendered; deterministic invocationId incl. iteration suffix; ok→completed with result; error→failed; re-entry same invocationId (dedup contract).

### Task 5: orchestrator executor + shared session machinery extraction

**Files:** create `packages/workflow/src/nodes/orchestrator.ts`; refactor `src/nodes/session.ts` extracting the shared receipt/result/repair helper (e.g. `src/nodes/submission-node.ts`); register; tests (fake `promptOrchestrator` + deps).
**Covers:** decision 5. Session executor tests pass UNCHANGED; orchestrator tests mirror the session matrix (dispatch idempotency, wait none, park/wake, repair once, failure mapping) plus queueMode 'followup' asserted on every dispatch.

### Task 6: foreach executor

**Files:** create `packages/workflow/src/nodes/foreach.ts`; register; tests (drive through `driveUntilPark`, fake deps).
**Covers:** decision 8 — the full matrix: non-array items → failed; truncation + counts; aliases in body template context; sequential completion; concurrency 2 with parking session bodies (two intents in flight, park carries both waitingOn entries, wakes complete out of order); onItemError fail (in-flight left, un-started not started) / skip / collect; re-drive skips terminal iterations and re-enters intent-holding ones (call counts); aggregate ForeachResult shape; foreach + downstream node consuming `nodes.<foreachId>.output.items`.

### Task 7: api deps implementations

**Files:** modify `packages/api/src/workflows/engine-deps.ts` (llmComplete via pi-ai `getModel`+`completeSimple`; promptOrchestrator via the EngineHost orchestrator path — reuse how Phase 4 admits internal signals/prompts to the orchestrator, see `packages/api/src/orchestrator/signals.ts` + `host.ts` orchestratorSessionFor; invokeAction stub per decision 3); tests: unit for the stub + prompt-orchestrator wiring against the existing api test harness; ONE key-gated integration test (real Anthropic): llm node end-to-end through a run (definition trigger→llm→stop, schema-validated output asserted).
**Note:** the orchestrator prompt must resolve the RUN's owner (available via the run row / resolveRunContext pattern already in this file).

### Task 8: editor model (lift + trim) 

**Files:** create `packages/web/src/components/workflows/editor-model.ts` (+ `editor-model.test.ts` adapted from main's), `NODE_META` table.
**Covers:** decision 9. Lift from `git show main:packages/client/src/components/workflows/workflow-editor-model.ts` — keep the pure logic, strip NODE_DOCS/legacy imports, trim to v2 nodes, add the BFS auto-layout. Tests: conversion round-trip (incl. ui positions + viewport), connect rules (trigger single-root, fromOutput handles, no self-edge), add/remove/duplicate, auto-layout determinism.

### Task 9: editor canvas presentation

**Files:** add `@xyflow/react` to packages/web; create `packages/web/src/components/workflows/editor/{canvas.tsx,flow-node.tsx,flow-edge.tsx,palette.tsx}`; ResizeObserver test-setup shim if needed.
**Covers:** decision 10's canvas half (custom node, true/false handles, when-badge edges, palette, selection, drag persistence into the model). Component tests: palette adds node; node renders label/summary/error badge; xyflow mounts in jsdom.

### Task 10: inspector + validation + save + JSON toggle

**Files:** create `editor/{inspector.tsx,fields.tsx,edge-inspector.tsx}`, `editor/validation-banner.tsx`; wire `validate()` from `@valet/workflow`.
**Covers:** decision 10's inspector half (per-type forms incl. foreach body sub-form and if-condition fields mirroring the v2 IfNode shape) + validation banner + Save (PUT full definition incl. ui) + Edit-JSON toggle round-trip. Component tests per decision 12.

### Task 11: routes restructure + "New workflow" flow

**Files:** create `packages/web/src/routes/workflows.$workflowId.tsx` (editor page: canvas+inspector+Save+Run+runs section); modify `workflows.index.tsx` (list links to editor; New workflow creates minimal trigger→stop def then navigates); api hooks as needed.
**Covers:** decision 11. Tests: list link, create-navigates, editor page loads definition into the model, Run from editor page starts a run.

### Task 12: dogfood

Manual, per decision 13 (real Anthropic + Docker + Chrome). Fix-forward anything found; record results in the ledger. Exit gate: the decision-13 workflow authored entirely in the editor runs to settled/completed with the orchestrator turn visible in chat and the approval resolved from the bell; the tool-node workflow fails cleanly with the stub's message in the run detail.

---

## Exit Criteria

All four node types execute on the v2 interpreter with Phase-5 durability semantics (conformance: existing suites green + the new executor test matrices); `@valet/workflow` + api + web suites green; typecheck sanctioned-only; the visual editor authors, validates, saves, and runs real workflows end-to-end in the browser (decision-13 dogfood passed).
