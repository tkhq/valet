# Security Platform Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Security module use five platform capabilities that landed on `dev-v2` after it was designed: durable child settlement, the child question contract, web-first attention, task tool scopes, and background work with leases.

**Architecture:** Every change stays inside the Security module (api routes, services, engine tools, runner driver, plugin-security prompts, specs). No schema change. No engine change. Each task is independent of the others except Task 2 and Task 5, which both edit the runner skill file.

**Tech Stack:** TypeScript, Hono, Drizzle, vitest; `@valet/shared` tool scopes; `packages/api/src/orchestrator/attention.ts`; `packages/api/src/engine/wakeups-admin.ts`.

**Spec:** `docs/specs/valet-security/spec/11-runtime-execution.md` (runner and cell contract), `docs/specs/2026-08-27-valet-security-design.md` (Autonomy: the nudge sweep), `docs/specs/2026-10-08-sandbox-scratch-wakeups-leases-design.md` (C4), `docs/specs/2026-10-15-task-tool-scopes-design.md`, `docs/specs/2026-10-20-notification-escalation-design.md`.

## Global Constraints

- Worktree: `/Users/akshar/tkhq/code/valet-worktrees/sec-rebase-trial`, branch `trial/security-v2-rebase`. The branch holds one squashed commit on top of `origin/dev-v2`. Commit each task on top; the controller squashes at the end.
- Commit with `git -c commit.gpgsign=false commit -m "<subject>" -- <paths>`. Subjects 72 chars or fewer. No `Co-Authored-By` trailer that names an AI.
- No em dash or en dash anywhere: code, comments, prompts, specs, commit text. Use a comma or a plain hyphen. Check added lines with `git diff <base> | grep '^+' | python3 -c "import sys,re; print(sum(1 for l in sys.stdin if re.search('[\\u2014\\u2013]', l)))"` and expect `0`.
- Writing is ASD-STE100: one instruction per sentence, 20 words or fewer for an instruction, active voice. Every user-facing error message names the corrective action.
- Type safety: no `any`, no `as unknown as T`, no `@ts-ignore`. Narrow instead of casting.
- Tests: `pnpm --filter @valet/api test <filter>` with NO `--` before the filter. Run `pnpm typecheck` from the repo root after a change in `packages/shared` or `packages/plugin-security`, because api resolves them through built `dist/`.
- Node on this machine is 24; the repo pins 22. Only the `nested-kubernetes-vectors` archive test is known to differ. Do not chase that one.
- Persona cells are security child sessions. "Runner" is the orchestrator session that owns the engagement. "Cell" is a `security_cells` row; its `childSessionId` is the persona session.

## Review Focus

1. A need the coordinator auto-resolves must not notify a person. Test in Task 3 (`does not ping the owner for an auto-resolved tool need`).
2. Each human need pings once, and two distinct needs ping twice. Test in Task 3 (dedupe key `security-need:<needId>` and the `n-question-security-need:<id>-%` id prefix).
3. A runner ceiling that already lacks a `sec_fs_*` tool still produces a child without it. Intersection only narrows. Test in Task 4 (`keeps the runner ceiling's own refusals`).
4. A destroyed child (childGone) leaves no pending or running wakeups, so `complete` is not blocked by work the destroy marked lost. Test in Task 5 (`does not count lost work of a destroyed child`).
5. A failing attention delivery must not stop the runner sweep or the needs route. Tests in Task 3 (`a throwing alert sink does not break the sweep`) and the needs route call is wrapped in `.catch` like the close route.
6. While a persona's background scan runs, the runner is idle on purpose. The driver must not nudge it every sweep and must not trip the stall cap. Test in Task 5 (`does not nudge while the running cell's child holds background work`).

---

### Task 1: Personas record blocking items instead of ending with a question

Platform commit 583e7c9b2 gives every child session `CHILD_QUESTION_RULES` ("end your turn with the question as your result") in its system prompt and removes `ask_question`. A security persona must instead call `sec_need_report` and keep working. The dispatch prompt is the per-turn task text, so it carries the override. The post-restart rebuild path (`buildSession`) also drops `child: true`, so a rebuilt cell loses the child rules; fix that too.

**Files:**
- Modify: `packages/api/src/services/security-engagements.ts:431-617` (`buildDispatchPrompt`)
- Modify: `packages/api/src/engine/host.ts:1422` and `:1461` (`buildSession` system prompt)
- Modify: `docs/specs/valet-security/spec/11-runtime-execution.md` (the section that lists the dispatch prompt sections; grep `Resolved needs`)
- Test: `packages/api/src/services/security-engagements.test.ts`
- Test: `packages/api/src/engine/host.spec-provider.test.ts`

**Interfaces:**
- Consumes: `buildDispatchPrompt(cell, plan, readsCells, protocol, rescan = false, config = {}, needsResolutions = [])`, existing.
- Produces: a new prompt block with the exact heading `--- Blocking items ---`, placed after the `--- Credentials ---` block and before `--- Resolved needs (continue the blocked work) ---`. Exported constant `BLOCKING_ITEMS_RULE: string` from `security-engagements.ts` so the test and the spec quote one source.

- [ ] **Step 1: Write the failing test**

In `security-engagements.test.ts`, next to the existing `buildDispatchPrompt` tests:

```ts
it("tells the persona to record blocking items with sec_need_report, never to end with a question", () => {
  const prompt = buildDispatchPrompt(cell, plan, [], "protocol text");
  expect(prompt).toContain("--- Blocking items ---");
  expect(prompt).toContain(BLOCKING_ITEMS_RULE);
  expect(prompt.indexOf("--- Credentials ---")).toBeLessThan(prompt.indexOf("--- Blocking items ---"));
  expect(prompt.indexOf("--- Blocking items ---")).toBeLessThan(prompt.indexOf("--- Resolved needs"));
});
```

Build `cell` and `plan` the way the file's other `buildDispatchPrompt` tests do, with a config that declares one credential and one resolved need so both neighbor blocks render.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @valet/api test security-engagements`
Expected: FAIL, `BLOCKING_ITEMS_RULE` is not exported.

- [ ] **Step 3: Add the rule and the block**

In `security-engagements.ts`, export:

```ts
export const BLOCKING_ITEMS_RULE =
  "No person reads your turn. Do not end your turn with a question. " +
  "If a credential, a dependency, a scope item, a decision, or a tool blocks you, call sec_need_report with that kind. " +
  "Then continue with the work you can still cover. " +
  "The coordinator answers what is already authorized and batches the rest into one human ask. " +
  "Your cell re-runs with the answer.";
```

In `buildDispatchPrompt`, emit `--- Blocking items ---` followed by `BLOCKING_ITEMS_RULE` on the next line, after the credentials block and before the resolved-needs block. The block is unconditional.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @valet/api test security-engagements`
Expected: PASS.

- [ ] **Step 5: Write the failing rebuild test**

In `host.spec-provider.test.ts`, find the existing case that restores a security persona cell through `buildSession` (the one whose `systemPrompt` assertion sits near line 499 or 565; read both and pick the one that goes through the restore path). Add:

```ts
expect(systemPrompt).toContain("## Questions");
```

If neither case restores a cell through `buildSession`, add a case named `a rebuilt persona cell keeps the child rules` that uses the same fixture as the nearest restore test and asserts the line above.

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm --filter @valet/api test host.spec-provider`
Expected: FAIL on the `## Questions` assertion.

- [ ] **Step 7: Pass `child: true` on the rebuild path**

In `host.ts` `buildSession`, at both `codingSystemPrompt(...)` calls (restore at ~1422, create at ~1461), pass `child: personaCell !== undefined`. `personaCell` is already in scope (set near line 1397).

- [ ] **Step 8: Run both suites**

Run: `pnpm --filter @valet/api test host.spec-provider security-engagements`
Expected: PASS.

- [ ] **Step 9: Update the spec**

In `11-runtime-execution.md`, in the list of dispatch prompt sections, add one bullet for `Blocking items` and quote `BLOCKING_ITEMS_RULE` in a code span. State in one sentence that it overrides the platform child question rule for persona cells.

- [ ] **Step 10: Commit**

```bash
git -c commit.gpgsign=false commit -m "security: personas record blocking items, never end with a question" -- packages/api/src/services/security-engagements.ts packages/api/src/services/security-engagements.test.ts packages/api/src/engine/host.ts packages/api/src/engine/host.spec-provider.test.ts docs/specs/valet-security/spec/11-runtime-execution.md
```

---

### Task 2: Remove `sec_wait`; the runner ends its turn and the durable `child.settled` signal resumes it

Commit fdfaa45bb delivers `child.settled` through a durable outbox with boot recovery and retry. Commit 24c377a4b lets queued messages join a running turn at a tool boundary. `sec_wait` blocks one tool call for up to 1800 seconds, which delays every user message that long. Delete it. The runner driver already nudges an idle runner that still has work, so it stays as it is.

**Files:**
- Modify: `packages/api/src/engine/security-tools.ts:200-285, 406-462, 1101-1117`
- Modify: `packages/api/src/engine/security-tools.test.ts:50, 115-128, 537-610`
- Modify: `packages/plugin-security/skills/security-engagement-runner/SKILL.md:16, 22, 26, 28, 33-35`
- Modify: `docs/specs/2026-08-27-valet-security-design.md:280-286` (Autonomy: the nudge sweep)

**Interfaces:**
- Consumes: `buildSecurityRunnerTools()` returns the runner tool list.
- Produces: the runner tool list has eleven tools and no `sec_wait`. `SEC_WAIT_DEFAULT_SECONDS`, `SEC_WAIT_MAX_SECONDS`, `secWaitTool` and `delay` no longer exist.

- [ ] **Step 1: Change the tool-count test**

In `security-tools.test.ts`, rename the test at line 115 to `returns exactly the eleven runner sec_* tools`, remove `"sec_wait"` from the expected list, remove the `secWaitTool` import at line 50, and delete the whole `describe("sec_wait", ...)` block (lines 537 to about 610).

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @valet/api test security-tools`
Expected: FAIL, twelve tools returned, eleven expected.

- [ ] **Step 3: Delete the tool**

In `security-tools.ts` delete `secWaitTool` (406-462), the constants block (243-251), `delay` (253-268), the `engagementStatus` field of `StatusView` and its assignment (203-208, 233-240; keep `running`, it renders the status text), and the line in `buildSecurityRunnerTools` (1106). Rewrite the two doc comments that name `sec_wait` (200-202 and 271-272) to say that `sec_status` is the only reader.

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @valet/api test security-tools && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Rewrite the runner skill's waiting contract**

In `SKILL.md`:
- Line 16: replace the last sentence with: "A dispatched child runs for many minutes. After `sec_dispatch`, end your turn. The child's settlement starts your next turn as a `child.settled` signal."
- Line 22: replace with: "- If the child has NOT settled, end your turn. Do not poll with `sec_status`. Do not run `sleep`."
- Line 26: replace "then call `sec_wait` for the next settle" with "then end your turn".
- Line 28: replace "call `sec_dispatch`, then call `sec_wait`" with "call `sec_dispatch`, then end your turn".
- Replace the `## Waiting` section (33-35) with:

```
## Waiting

You never wait inside a tool call. After `sec_dispatch`, end your turn. The platform delivers the child's `child.settled` signal to this thread and starts your next turn. When a turn starts, call `sec_status` first and act on the snapshot. Do not poll with repeated `sec_status` calls. Do not run the bash `sleep` command. If a turn starts with no signal and a cell is still running, end your turn again.
```

- [ ] **Step 6: Update the design doc**

In `2026-08-27-valet-security-design.md`, Autonomy section (280-286), add one sentence: "Since the durable child outbox (TKAI-657) the runner ends its turn after a dispatch; the sweep covers only a runner that stopped with work left."

- [ ] **Step 7: Confirm nothing else names the tool**

Run: `git grep -n 'sec_wait\|secWait\|SEC_WAIT' -- . ':!docs/plans'`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git -c commit.gpgsign=false commit -m "security: drop sec_wait, durable child.settled resumes the runner" -- packages/api/src/engine/security-tools.ts packages/api/src/engine/security-tools.test.ts packages/plugin-security/skills/security-engagement-runner/SKILL.md docs/specs/2026-08-27-valet-security-design.md
```

---

### Task 3: Route needs and runner alerts through attention

Only close and cancel call `routeAttention`. A need that waits for a person is visible only in the security panel. The driver's stall and submit-failure alerts are prompts to the runner model, not notices to a person, and the submit-failure alert goes over the seam that just failed.

**Files:**
- Modify: `packages/api/src/routes/security.ts:2181-2216` (needs POST), `:2494-2554` (needs resolve), `:949-952` (`attentionDepsFrom`)
- Modify: `packages/api/src/orchestrator/security-runner-driver.ts:97-113, 136-180, 273-282`
- Modify: `packages/api/src/providers/node.ts:667-673` and `packages/api/src/integration/_setup.ts:450` (driver deps wiring)
- Test: `packages/api/src/orchestrator/security-runner-driver.test.ts`
- Test: `packages/api/src/integration/security-needs-attention.test.ts` (create; copy the harness and notification-table pattern from `security-cancel.test.ts`)

**Interfaces:**
- Consumes: `routeAttention(deps: AttentionDeps, event: AttentionEvent)`, `markAttentionNotificationsRead(db, kind, dedupeKey)`, `attentionHref(sessionId, threadId?, owner?)`, `sessionOwner(row)` (routes/security.ts:939), `ResolveNeedsResult { autoResolved; needsHuman; pendingHuman }`.
- Produces: driver deps gain `alert?: RunnerAlert` where `export type RunnerAlert = (row: typeof agentSessions.$inferSelect, event: { title: string; body: string; dedupeKey: string }) => Promise<void>`. Need notifications use kind `"question"` and dedupe key `security-need:${need.id}`. Driver alerts use kind `"escalation"` and dedupe keys `security-stall:${engagementId}:${sig}` and `security-runner-down:${engagementId}`, where `sig` is a short hash (8 hex chars of sha1) of the driver's progress signature string, so a second stall episode after progress pings again. `routeAttention` dedupe is permanent per key.

- [ ] **Step 1: Write the failing integration tests**

In the new `security-needs-attention.test.ts`, using `createSecuritySession`, `buildPausedRunner`, `setPlanViaRoute`, `startViaRoute`, `dispatchViaRoute` from `security-harness.ts`, and the internal-token header pattern that `reportFindingAsChild` uses:

```ts
it("each human need pings the owner once with kind question", async () => {
  // report two distinct kind "decision" needs from the running cell's child
  // expect exactly one notifications row per need whose id matches `n-question-security-need:${needId}-%`
  // expect the href to equal attentionHref(sessionId) for this owner and the title to be "Security review needs an answer"
});
it("does not ping the owner for an auto-resolved tool need", async () => {
  // report a kind "tool" need for a tool the engagement config declares
  // expect zero rows with prefix `n-question-security-need:`
});
it("resolving the need marks its notification read", async () => {
  // report a decision need, then POST /needs/resolve with an answer as the human owner
  // expect the row's read_at to be non-null
});
```

Write the bodies against the real routes. The notifications table and column names are the ones `security-cancel.test.ts` queries.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @valet/api test security-needs-attention`
Expected: FAIL, zero notification rows.

- [ ] **Step 3: Notify on a human need**

In the needs POST handler, after `security.resolveNeeds(...)`: if the reported need is in `swept.needsHuman` (match by id; read the shape of `needsHuman` in `ResolveNeedsResult` at services/security-engagements.ts:298), load the runner row with `db.select().from(agentSessions).where(eq(agentSessions.id, engagement.sessionId)).limit(1)`, and call `routeAttention(attentionDepsFrom(c), { kind: "question", owner: sessionOwner(row), sessionId: engagement.sessionId, title: "Security review needs an answer", body: \`${engagement.repoFullName}: ${need.kind} need from cell ${cell.ordinal}. ${need.description.slice(0, 200)}\`, href: attentionHref(engagement.sessionId, undefined, sessionOwner(row)), dedupeKey: \`security-need:${need.id}\` }).catch(...)` with the same `console.error` wrapper the close route uses. Skip the call when the row is missing.

- [ ] **Step 4: Mark read on resolve**

In the needs resolve handler, after `resolveEngagementNeeds`, for each id in `answered` call `markAttentionNotificationsRead(db, "question", \`security-need:${id}\`)`. Import it from `../orchestrator/attention.js`.

- [ ] **Step 5: Run and confirm they pass**

Run: `pnpm --filter @valet/api test security-needs-attention security-cancel`
Expected: PASS.

- [ ] **Step 6: Write the failing driver tests**

In `security-runner-driver.test.ts`, with a `vi.fn()` alert in deps:

```ts
it("alerts the owner once when the stall cap trips", ...)   // alert called once with a dedupeKey that starts with `security-stall:${engagementId}:`, not called again until progress changes; after progress and a second stall, called again with a different key
it("alerts the owner when submit keeps failing, over the alert seam not the submit seam", ...) // submit rejects N times; alert called once with dedupeKey `security-runner-down:${engagementId}`
it("a throwing alert sink does not break the sweep", ...)   // alert rejects; the sweep still nudges on the next tick
```

Reuse the fixtures of the existing stall and submit-failure tests at lines 234 and 316.

- [ ] **Step 7: Run and confirm they fail**

Run: `pnpm --filter @valet/api test security-runner-driver`
Expected: FAIL, `alert` is not a known dep.

- [ ] **Step 8: Add the alert seam**

In the driver: add `alert?: RunnerAlert` to `SecurityRunnerDriverDeps`. At the stall cap (273-282) call `alert(runnerRow, { title: "Security review stalled", body: stallText(prior.stalls), dedupeKey: \`security-stall:${engagement.id}:${sig}\` })` in addition to the existing submit. At the submit-failure cap (162-168) call `alert(runnerRow, { title: "Security runner needs attention", body: SUBMIT_STALL_TEXT, dedupeKey: \`security-runner-down:${engagement.id}\` })` and keep the existing submit attempt. Wrap each alert call in try/catch that logs with `console.error("security-runner-driver: alert failed", err)`.

- [ ] **Step 9: Wire the seam**

First read `principalFromOwner` at `orchestrator/attention.ts:92`. If it builds the same `Principal` from `{ ownerType, ownerId, userId }` as `sessionOwner` does, use it and do not create `session-owner.ts`. Also add `access: providers` to `attentionDepsFrom` in routes/security.ts so the security routes match the boot wiring in main.ts:326-332 (channel escalation may read credentials through it).

In `providers/node.ts` (667-673) pass `alert: async (row, event) => routeAttention({ db, channels: providers.channelHost.attentionDeliverers(), access: providers }, { kind: "escalation", owner: ownerOf(row), sessionId: row.id, title: event.title, body: event.body, href: attentionHref(row.id, undefined, ownerOf(row)), dedupeKey: event.dedupeKey })`. `ownerOf` builds a `Principal` from `row.ownerType`, `row.ownerId`, `row.userId` the same way `sessionOwner` does in routes/security.ts:939; move `sessionOwner` to `packages/api/src/services/session-owner.ts` and import it in both places rather than copying it. Leave `_setup.ts` without an alert (optional dep).

- [ ] **Step 10: Run everything this task touched**

Run: `pnpm --filter @valet/api test security-runner-driver security-needs-attention security-cancel security-scope-nudge && pnpm typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git -c commit.gpgsign=false commit -m "security: route needs and runner alerts through attention" -- packages/api/src/routes/security.ts packages/api/src/orchestrator/security-runner-driver.ts packages/api/src/orchestrator/security-runner-driver.test.ts packages/api/src/providers/node.ts packages/api/src/services/session-owner.ts packages/api/src/integration/security-needs-attention.test.ts
```

---

### Task 4: Narrow each persona cell to its own tool scope

Dispatch passes the runner's full ceiling to the persona child, and the child gets the owner's whole plugin catalog through `call_tool`. A persona reads code an attacker controls. Intersect the runner ceiling with a per-persona scope: the persona's `sec_*` tools, the sandbox tools, and only the MCP actions the engagement declared. This is protection against a prompt-injected persona, not a network boundary.

**Files:**
- Create: `packages/api/src/services/security-persona-scope.ts`
- Create: `packages/api/src/services/security-persona-scope.test.ts`
- Modify: `packages/api/src/routes/security.ts:1646-1668` (dispatch `childSpawner` call)
- Modify: `packages/api/src/engine/security-tools.test.ts:337-370`
- Modify: `docs/specs/valet-security/spec/11-runtime-execution.md` (claim INV-32 for Persona tool scope; Part 11 lists INV-32 as unclaimed)

**Interfaces:**
- Consumes: `intersectToolScopes(...scopes)` and `ToolScope` from `@valet/shared`; `buildSecurityPersonaTools({ review, persona })` from `engine/security-tools.ts`; the MCP service ids that `packages/api/src/engine/security-provisioning.ts:104-128` derives from the engagement's declared tools (export that derivation as `declaredMcpServices(tools: ToolDecl[]): string[]` if it is not exported yet).
- Produces: `export function personaToolScope(persona: string, mcpServices: readonly string[]): ToolScope` in `security-persona-scope.ts`, `export const PERSONA_SANDBOX_TOOLS: readonly string[]`, and `export const PERSONA_DENIED_TOOLS: readonly string[]` = `["child_send", "child_read", "child_status", "ask_question", "ask_approval", "switch_model", "wait_for_event", "task", "list_threads"]`.
- Allowlist semantics: `ToolScope.tools` is an exact-name allowlist that `buildTools` applies to every ToolDef, so `PERSONA_SANDBOX_TOOLS` must name every builtin a persona child receives except `PERSONA_DENIED_TOOLS`. Derive it from the code, not from this plan: `packages/engine/src/builtin-tools/index.ts`, `update-plan.ts`, `wakeups.ts`, `plugin-catalog.ts` (`list_tools`, `call_tool`), `packages/api/src/plugins/tool-focus.ts` (`focus_tools`), the native images tool name in `packages/engine/src/thread.ts` (`this.nativeImages.tool()`), and any skill-file tools from TKAI-658. The exhaustiveness test in Step 5 is the proof.
- Declared MCP tools are engagement-wide (`config.tools`), so every persona gets `${svc}.*` for each declared service, not only live personas.

- [ ] **Step 1: Write the failing unit tests**

```ts
it("gives a static persona its sec tools and the sandbox tools, and no actions", () => {
  const scope = personaToolScope("sast", []);
  expect(scope.tools).toEqual(expect.arrayContaining(["sec_fs_write", "sec_fs_read", "sec_fs_list", "sec_protocol_read", "sec_finding_report", "sec_coverage_report", "sec_need_report", "read", "write", "edit", "bash", "update_plan", "thread_read", "watch", "wake_at", "hold_sandbox", "process_read", "wakeup_list", "wakeup_cancel", "list_tools", "call_tool", "focus_tools"]));
  expect(scope.tools).not.toEqual(expect.arrayContaining(["child_send", "child_read", "child_status", "ask_question", "ask_approval", "switch_model", "wait_for_event", "task", "list_threads"]));
  expect(scope.actions).toEqual([]);
});
it("gives every persona the declared MCP services as wildcard actions", () => {
  expect(personaToolScope("dast", ["zap", "nuclei"]).actions).toEqual(["zap.*", "nuclei.*"]);
  expect(personaToolScope("sast", ["semgrep"]).actions).toEqual(["semgrep.*"]);
});
it("gives the report persona sec_report_write and reconcile sec_finding_review", () => {
  expect(personaToolScope("report", []).tools).toContain("sec_report_write");
  expect(personaToolScope("reconcile", []).tools).toContain("sec_finding_review");
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @valet/api test security-persona-scope`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `personaToolScope`**

`PERSONA_SANDBOX_TOOLS` contains at least the names in the first test and every other builtin found per the Interfaces block (it may be longer than the test's `arrayContaining` list). `tools` = names of `buildSecurityPersonaTools({ review: true, persona })` plus `PERSONA_SANDBOX_TOOLS`. `actions` = `mcpServices.map((s) => \`${s}.*\`)`. Dedupe `tools`.

- [ ] **Step 4: Run and confirm they pass**

Run: `pnpm --filter @valet/api test security-persona-scope`
Expected: PASS.

- [ ] **Step 5: Write the failing dispatch tests**

In `security-tools.test.ts`, next to the test at line 337, add:

```ts
it("narrows a persona child to its own tool scope and removes only the denied tools", ...)  // runner ceiling undefined; after dispatch read the child session's options.toolScope and the full list of ToolDef names the child session was built with (builtinTools plus options.tools; find how the test file reaches the child session). Assert: every name in that list is either in scope.tools or in PERSONA_DENIED_TOOLS; "sec_fs_write" and "bash" are in scope.tools; "child_send" is not; actions equals []
it("keeps the runner ceiling's own refusals", ...)          // runner ceiling { tools: ["sec_dispatch", "bash"], actions: [] }; child toolScope.tools equals ["bash"]
```

Read how the test at 356-370 reaches the child session's `toolScope` and assert the same way.

- [ ] **Step 6: Run and confirm they fail**

Run: `pnpm --filter @valet/api test security-tools`
Expected: FAIL, child scope equals the ceiling.

- [ ] **Step 7: Intersect at dispatch**

In the dispatch route's `spawn` closure, replace `toolScope: readToolScope(body.toolScope)` with `toolScope: intersectToolScopes(readToolScope(body.toolScope), personaToolScope(cell.persona, mcpServices))`, where `cell` is the cell being dispatched (the `SpawnCellChild` request or the service's cell; read `security.dispatchCell` to find which object carries `persona`) and `mcpServices` comes from the engagement's declared tools through `declaredMcpServices`. Leave the handoff route unchanged: a handoff child is a fix task for the owner, not a persona.

- [ ] **Step 8: Run and confirm they pass**

Run: `pnpm --filter @valet/api test security-tools security-persona-scope security-acceptance security-persona && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Spec**

In `11-runtime-execution.md` claim the unclaimed `INV-32 (persona tool scope)`: "A persona cell's tool scope is the runner ceiling intersected with the persona's `sec_*` tools, the sandbox tools, and the `svc.*` actions of the engagement's declared MCP tools. A persona never holds `child_*`, `ask_question`, `ask_approval`, `switch_model`, `wait_for_event`, or `task`. This limits a prompt-injected persona; it is not a network boundary." Name `PERSONA_SANDBOX_TOOLS` as the list's source.

- [ ] **Step 10: Commit**

```bash
git -c commit.gpgsign=false commit -m "security: narrow each persona cell to its own tool scope (INV-32)" -- packages/api/src/services/security-persona-scope.ts packages/api/src/services/security-persona-scope.test.ts packages/api/src/routes/security.ts packages/api/src/engine/security-tools.test.ts packages/api/src/engine/security-provisioning.ts docs/specs/valet-security/spec/11-runtime-execution.md
```

---

### Task 5: A cell cannot complete while its child holds background work; long scans run in the background

Every persona child can run `bash` with `background: true`, `watch`, `wake_at`, and hold leases. Spec C4 says `child.settled` does not wait for that work. The complete route trusts `resolveChildSettlement`, which reads only submissions, so a persona that backgrounds a scanner gets its cell completed and its write claim revoked before the scan ends. Make `complete` refuse while work is open, show it in `sec_status`, and tell the live personas how to use background scans.

**Files:**
- Modify: `packages/api/src/orchestrator/security-runner-driver.ts:97-113, 222-236` (deps `engineStore` Pick and the running-cell branch)
- Test: `packages/api/src/orchestrator/security-runner-driver.test.ts`
- Modify: `packages/api/src/services/security-engagements.ts:1466-1509` (`completeCell`)
- Modify: `packages/api/src/routes/security.ts:1102-1158` (status), `:1709-1754` (complete)
- Modify: `packages/api/src/wire/types.ts` (`runningChild` in the security status response)
- Modify: `packages/api/src/engine/security-tools.ts` (`sec_status` text and `sec_cell_complete` description)
- Modify: `packages/plugin-security/personas/dast.md`, `fuzz.md`, `exploit.md`; `packages/plugin-security/skills/security-engagement-runner/SKILL.md`
- Modify: `docs/specs/valet-security/spec/11-runtime-execution.md` (cell completion rule)
- Test: `packages/api/src/services/security-engagements.test.ts`, `packages/api/src/engine/security-tools.test.ts:414-500`

**Interfaces:**
- Consumes: `listBackgroundWork(engineStore: SessionStore, sessionId): Promise<BackgroundWork>` and `selectWork(work, filter): BlockingWork[]` from `engine/wakeups-admin.ts` (confirm every `BackgroundWorkFilter` field is optional before calling it with `{}`; if not, pass the minimal filter that selects everything); `engineStore.createLease` and `createWakeup` for test seeding (snippets at `routes/wakeups.test.ts:182-198` and `230-243`).
- Produces: `completeCell(engagementId, cellId, args: { settled: boolean; openBackgroundWork: number })`. Wire: `runningChild.backgroundWork: number` (required). Error text: `The cell's child still has ${n} background item(s): processes, timers, or leases. Wait for them to end, or tell the persona to cancel them with wakeup_cancel.`

- [ ] **Step 1: Write the failing service test**

```ts
it("completeCell refuses while the child has background work", async () => {
  // same fixture as "completeCell refuses an unsettled child" at line 474, but settled: true, openBackgroundWork: 2
  await expect(service.completeCell(eng.id, cell.id, { settled: true, openBackgroundWork: 2 }))
    .rejects.toThrow("still has 2 background item(s)");
});
```

Update the five existing `completeCell` calls in this file to pass `openBackgroundWork: 0`.

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @valet/api test security-engagements`
Expected: FAIL, type error on the new field or no throw.

- [ ] **Step 3: Implement the refusal**

In `completeCell`, after the `settled` check, if `args.openBackgroundWork > 0` throw the error text from Interfaces.

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @valet/api test security-engagements`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

In `security-tools.test.ts` inside `describe("sec_cell_complete")`:

```ts
it("refuses while the child has background work, naming wakeup_cancel", ...) // seed the child's settled watch as the test at 415 does, then engineStore.createLease({ ownerKind: "hold", sessionId: childSessionId, ... }); expect the tool text to contain "wakeup_cancel"
it("does not count lost work of a destroyed child", ...)                    // seed a wakeup with status "lost" for the child; complete succeeds
```

And in the `sec_status` tests: `it("reports open background work of the running child", ...)` expecting the status text to contain `background work: 1 open` and the JSON `runningChild.backgroundWork` to equal 1.

- [ ] **Step 6: Run and confirm they fail**

Run: `pnpm --filter @valet/api test security-tools`
Expected: FAIL.

- [ ] **Step 7: Count work in the routes**

Add a helper in `routes/security.ts`: `async function openBackgroundWork(engineStore: SessionStore, childSessionId: string): Promise<number>` returning `selectWork(await listBackgroundWork(engineStore, childSessionId), {}).length` (`selectWork` returns one flat `BlockingWork[]` and drops child subscriptions). In the complete route pass `openBackgroundWork` to `completeCell`. In the status route add `backgroundWork` to `runningChild`, and in `wire/types.ts` add `backgroundWork: number` to that object type. In `security-tools.ts` `sec_status` rendering, append ` background work: ${n} open` to the running-child line when `n > 0`. Extend the `sec_cell_complete` description with: "Refused while the child still has background work; wait for the next settle."

- [ ] **Step 8: Run and confirm they pass**

Run: `pnpm --filter @valet/api test security-tools security-engagements security-acceptance security-yield security-settlement && pnpm typecheck && pnpm --filter @valet/web typecheck`
Expected: PASS. If the web reads `runningChild`, the web typecheck names the file to update.

- [ ] **Step 8b: The driver must not nudge during a background scan**

Sequence without this step: the persona backgrounds a scan and ends its turn; `child.settled` reaches the runner; `sec_cell_complete` is refused; the runner ends its turn; the driver sees a running cell whose child has no unsettled submission, nudges every 20 s, trips the stall cap, and (Task 3) escalates to the owner. Write the failing test in `security-runner-driver.test.ts`: `does not nudge while the running cell's child holds background work` (seed a hold lease for the child with `engineStore.createLease`, or stub `listWakeups`/`listActiveLeases` on the test's engineStore the way the file stubs `listUnsettledSubmissions`). Then in `driveEngagement`, in the running-cell branch (222-236), return when `selectWork(await listBackgroundWork(engineStore, childSessionId), {}).length > 0`. Widen `SecurityRunnerDriverDeps.engineStore` to `Pick<SessionStore, "getSession" | "listThreads" | "listWakeups" | "listActiveLeases">` plus `listUnsettledSubmissions`, and update the two places that build the deps (`providers/node.ts`, `integration/_setup.ts`) and the test fixtures. Note that Task 3 added `alert?` to the same deps type; keep it. Run `pnpm --filter @valet/api test security-runner-driver security-scope-nudge` and expect PASS.

- [ ] **Step 9: Persona and runner guidance**

Add this section to `dast.md`, `fuzz.md`, and `exploit.md`, directly before each file's `Yield deliberately` section:

```
## Long scans

Run a scan that needs more than an hour with `bash`, `background: true`, a `deadline_hours`, and a `reason`. Then write `state.yml` with the scan listed as in progress and end your turn. When the scan ends, your thread wakes with a `process.exited` signal. Read the output with `process_read`, record findings with `sec_finding_report`, then update `state.yml`. Do not set `status: done` while a background scan runs. Cancel a scan you no longer need with `wakeup_cancel`.
```

In `SKILL.md`, in the loop steps, add after the complete step: "- If `sec_cell_complete` is refused because the child has background work, end your turn. The next `child.settled` arrives when the work ends."

- [ ] **Step 10: Spec**

In `11-runtime-execution.md`, in the cell completion rule, add: "A cell cannot complete while its child holds open background work (pending or running wakeups, active leases). The runner waits for the next `child.settled`."

- [ ] **Step 11: Commit**

```bash
git -c commit.gpgsign=false commit -m "security: cells wait for background work; long scans run detached" -- packages/api/src/orchestrator/security-runner-driver.ts packages/api/src/orchestrator/security-runner-driver.test.ts packages/api/src/providers/node.ts packages/api/src/integration/_setup.ts packages/api/src/services/security-engagements.ts packages/api/src/services/security-engagements.test.ts packages/api/src/routes/security.ts packages/api/src/wire/types.ts packages/api/src/engine/security-tools.ts packages/api/src/engine/security-tools.test.ts packages/plugin-security/personas/dast.md packages/plugin-security/personas/fuzz.md packages/plugin-security/personas/exploit.md packages/plugin-security/skills/security-engagement-runner/SKILL.md docs/specs/valet-security/spec/11-runtime-execution.md
```

---

### Task 6: Validation and PR text (controller)

- [ ] Run `pnpm typecheck`, `pnpm --filter @valet/api test security sandbox-secrets`, `pnpm --filter @valet/plugin-security test`, `pnpm --filter @valet/web test security control`, `pnpm --filter @valet/engine test credential-sanitizer-roundtrip tool-call-streaming happy-path`.
- [ ] Run the quality pass: `domain-expert-reviewer` (TypeScript) and `lean-code-reviewer` on `git diff <rebased-squash>..HEAD`.
- [ ] Dash scan over added lines and commit bodies: expect 0.
- [ ] Add a `v1.2, 2026-10-28` line to the version history in `docs/specs/valet-security/README.md` naming the five changes in one sentence each. Run `python3 -I scripts/docs/docs_lint.py` the way `make e2e E2E_ARGS="--only docs-lint"` runs it, or that make target.
- [ ] Commit this plan file (`docs/plans/2026-10-28-security-platform-adoption.md`) so the reviewer can read the reasoning; lint it with the ste linter first.
- [ ] Update the PR body (under 300 words, lint with `python3 -I scripts/docs/pr_description_lint.py < body.md`): one bullet per task under a `Platform adoption` heading, and the sec_wait removal under the Valet-team note.
- [ ] Squash onto the single commit, keep the `Changelog:` and `Co-authored-by: Conner Swann` trailers in the last paragraph, force-push with lease, watch CI.
