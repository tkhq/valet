# Remove Runtime from workflow authoring

Status: proposed removal plan. This PR changes no application behavior or authorization.

## Existing baseline (informative)

[PR #818](https://github.com/tkhq/valet/pull/818) shipped the workspace Thread path.
Thread uses the stored discriminator `orchestrator`. Runtime uses `session`.
Engine sessions remain necessary for sandbox ownership and recovery after Runtime leaves workflow authoring.
This plan removes the workflow node choice. It does not remove engine sessions.

The following shipped contracts remain authoritative:

- [Thread execution isolation](2026-10-05-thread-execution-isolation-design.md): execution, memory scope, audience routing, and origin restrictions.
- [Legacy continuity](2026-10-06-legacy-continuity-design.md): retained runtime identities, directories, admissions, and files.
- [Thread API cleanup](2026-10-04-thread-api-cleanup-design.md): access, credentials, and recovery.
- [Agent step grants](2026-10-17-agent-step-workflow-grants-design.md): saved grants and unattended execution.

The inventory describes the checkout at `c866e6b0`, including changes after #818.
Workspace access, step `toolScope`, workspace targeting, and Slack audience routing are existing behavior, outside this removal plan.

## Removal acceptance scenario (normative)

These vectors define future implementation checks. This spec PR does not claim that they pass.
MUST identifies a requirement. Prose without a requirement keyword is informative.

| Vector | Input or operation | Required result |
| --- | --- | --- |
| V1 | Create a graph containing top-level `session` | Save MUST fail with a node-specific conversion instruction after the deprecation gate ships. |
| V2 | Import, copy, patch, or repository-sync a graph containing a foreach `session` body | Definition writes MUST apply the same save gate as V1. |
| V3 | Rename a saved Runtime workflow without replacing its graph | Rename MUST retain the original graph and execution behavior. |
| V4 | Run an unchanged saved Runtime definition after deployment | The run MUST use the existing Runtime executor and file paths. Schedules MUST remain armed. |
| V5 | Restart during Runtime primary dispatch, parked wait, or schema repair | Recovery MUST reuse the original admission, receipt, session, and completed tool results. |
| V6 | Preview explicit Runtime conversion with a model, title, script, and result reference | Preview MUST identify unsupported dependencies before the author saves. |
| V7 | Run converted foreach steps with models and structured outputs | Each iteration MUST retain distinct receipts, outputs, budgets, and usage attribution. |
| V8 | Convert while an older version has active runs | Active runs MUST retain their snapshots. New runs MUST use the saved new version. |
| V9 | Retry converted primary and repair submissions | Retry MUST return the original receipt without repeating external actions. |

Generated IDs and timestamps are outside exact-value comparison. Tests compare persisted identities before and after restart.

## Capability inventory (informative)

**Covered** means existing Thread behavior suffices. **Close** means work blocks equivalent conversion. **Drop** means deliberate new-authoring removal.
Covered features need regression checks during removal. They need no new Thread architecture.

| Capability | Runtime and Thread difference | Disposition and removal treatment |
| --- | --- | --- |
| Sandbox and shell | Runtime lazily provisions a headless sandbox per run/node/iteration. Thread already has shell and filesystem tools in its resolved execution. | **Covered** for shell capability. **Drop** automatic per-step sandbox allocation for converted graphs. |
| Working files and processes | Runtime uses `~/.valet/workflows/<run>/<node>/<iteration>`. Thread uses its existing execution directory. | **Close** conversion review for absolute paths, relative files, background processes, and cleanup assumptions. Retain old directories in place. |
| Sandbox actions API | `/api/sandbox/actions/:toolId/invoke` admits active Runtime sessions. It rejects Thread sandboxes. | **Close** before converting script-dependent graphs. A separate API slice must identify the active step without widening sandbox-token authority. Explicit `tool` nodes remain an alternative. |
| `model` | Runtime passes its optional model to primary and repair submissions. Thread has no node model field. | **Close** with a per-submission Thread model field, existing organization resolution, and repair parity. Never mutate the workspace default. |
| `title` | Runtime sets session metadata. Thread has no node title field. | **Drop** dedicated session titles. Conversion uses the node ID as its step label and discloses the lost title. No new thread-title mutation. |
| `mode` | Runtime supports only `start`. Thread has no mode field. | **Drop** during explicit conversion. No steer or attach replacement is needed. |
| `wait` | Both use `none` and `until_idle` through `executeSubmissionNode`. Omission waits for settlement. | **Covered**. Dispatch-only success means admission, not completed work. |
| `wait.timeout` | The Runtime TypeScript interface includes timeout. The shared executor reads only `wait.mode`. | **Drop** this ineffective field. Preview flags its presence. No new timeout semantics. |
| Per-step transcript isolation | Runtime has a deterministic session per step and iteration. Thread uses the existing run/origin conversation and serial queue. | **Drop** fresh per-step conversation guarantees for converted graphs. Preview warns about shared context, serialization, and cancellation scope. |
| Foreach concurrency | Both node types are allowed as bodies. Runtime iterations have separate sessions. Thread uses the existing run/origin thread. | **Covered** for indexed results and dispatch identity. **Drop** independent agent-turn parallelism within one Thread queue. Keep non-agent concurrency unchanged. |
| Cost and usage | Runtime writes under `wf:<run>:<node>[:<iteration>]`. Thread entries live under assistant sessions. | **Covered** by `valet_usage_step_session` and usage projections. Preserve dispatch IDs, repair attribution, model reporting, and iteration totals. |
| Prompt, schema, repair | Both render templates and share submission machinery with one bounded schema-repair turn. | **Covered**. Keep `response` and `output` semantics. |
| Result identity | Both return `sessionId`. Thread also returns `threadId`. Dispatch-only results include a receipt. | **Close** conversion review of session-ID templates, URLs, script arguments, and consumers. Never synthesize a Runtime ID for Thread. |
| Model-call budget | Both pass `maxModelCalls` to primary and repair submissions. | **Covered**. Preserve the existing default and repair budget behavior. |
| Recovery and retries | Both persist intent and receipts, with deterministic primary and repair dispatch IDs. | **Covered**. Keep Runtime execution for stored graphs and snapshots. |
| Memory, skills, integrations, children, browser, attachments, artifacts | Thread already uses the workspace assistant builder. Runtime has a narrower builder and distinct file identity. | **Covered** by shipped Thread behavior. Conversion discloses changed memory/context and publication identity. No access expansion here. |
| Scope, grants, credentials, unattended decisions | Existing host paths enforce these for both agent types. | **Covered** by current policy and step-grant contracts. Graph edits retain grant invalidation. |
| Owner, origin, reports, Slack sender | Existing Thread routing resolves execution and report targets, including legacy admissions. | **Covered** by #818 contracts and current code. No workspace selector or audience redesign. |
| Authoring and model-update tools | Canvas, templates, generated reference, imports, aggregate helpers, and `update_model` still know Runtime. | **Close** all new-authoring surfaces together. Keep legacy readers and diagnostics. |
| Historical diagnostics and reclamation | Runtime logs, costs, transcripts, and sandbox cleanup use `wf:` identities. | **Covered** through retained compatibility readers and cleanup. Authoring removal does not delete history or sandboxes. |

Inventory sources:

- Execution: [nodes](../../packages/workflow/src/dag/nodes.ts), [Runtime](../../packages/workflow/src/nodes/session.ts), and [Thread](../../packages/workflow/src/nodes/thread.ts).
- Lifecycle: [shared submission executor](../../packages/workflow/src/nodes/submission-node.ts).
- Runtime construction: [engine bridge](../../packages/api/src/workflows/engine-deps.ts) and [host](../../packages/api/src/engine/host.ts).
- Script admission: [sandbox actions](../../packages/api/src/routes/sandbox-actions.ts).
- Usage projection: [application schema](../../packages/api/migrations/pg/0000_app.sql).
- Authoring: [editor model](../../packages/web/src/components/workflows/editor-model.ts).

## Compatibility and invariants (normative)

1. **INV-1, snapshot execution:** The interpreter MUST retain `session` support for saved definitions, versions, and run snapshots.
   Save validation MUST remain separate from structural read and execution validation. V1 through V5 check this boundary.
2. **INV-2, explicit conversion:** The system MUST NOT translate stored Runtime nodes automatically.
   Conversion MUST require an author-reviewed replacement graph. V6 checks the preview and acceptance.
3. **INV-3, admission continuity:** Recovery MUST preserve session IDs, thread IDs, queue items, dispatch IDs, and completed external results.
   Existing `session-recovery.test.ts` and new V5/V9 fixtures check this invariant.
4. **INV-4, retained resources:** Removal MUST preserve schedules, subscriptions, grants, files, artifacts, approvals, and history under existing contracts.
   Explicit graph edits MUST retain existing grant revocation. V4/V8 and continuity fixtures check this invariant.
5. **INV-5, unchanged authority:** Removal MUST reuse existing Thread routing, audience, scope, and authorization behavior.
   Removal MUST NOT silently relax origin restrictions or script admission. Existing isolation and step-grant tests check this boundary.

An unchanged saved Runtime graph can start new runs during the compatibility period.
Definition replacement, copying, and repository import count as new definition writes once the save gate ships.
Metadata-only edits remain available. A replacement containing Runtime fails even when unrelated nodes changed.
Repository sync MUST retain the last valid saved graph and report the rejected file without disabling its existing triggers.
Read/export paths MUST retain legacy fields. Exported Runtime files require conversion before reimport under the new save gate.

This PR requires no schema change. Later schema changes MUST edit `0000` in place and include applicable repair and reset steps.
Executor deletion needs a separate retirement decision after all saved Runtime graphs and resumable snapshots have explicit dispositions.
Elapsed time alone cannot establish safe deletion.

## Implementation slices (informative)

1. **Thread model parity:** Extend node types, validation, templating, dispatch, repair, `update_model`, editor, and generated reference.
   Check invalid/disallowed models, omitted defaults, per-item isolation, repair, and concurrent runs. Do not rebuild workspace routing.
2. **Script migration:** Specify and implement Thread sandbox-action step admission in a separate reviewed PR.
   Test forged, stale, concurrent, settled, cross-owner, and widened-scope requests, plus valid calls and idempotent retries.
   Keep current Runtime admission. This removal spec grants no new authorization.
3. **Conversion preview:** Show removed `mode`, `title`, and ineffective timeout fields, file dependencies, changed isolation, and result-identity dependencies.
   Preserve node IDs, edges, prompts, schemas, scopes, budgets, and supported wait modes. Require explicit confirmation.
4. **Authoring gate:** Remove Runtime from creation menus, templates, examples, and generated guidance.
   Add one save-only refusal across API create/update/copy/patch, aggregate helpers, file import, and repository sync.
   Ship after model and script dependencies have a supported disposition. Keep legacy editing visible and explain conversion before graph saves.
5. **Compatibility verification:** Exercise V1 through V9 with saved definitions, active versions, schedules, parked submissions, repairs, and retained files.
   Keep Runtime execution, diagnostics, usage attribution, and reclaim code until the separate retirement decision.

## Event-log privacy repro (informative)

The repro is independent of Runtime removal. This PR includes and specifies no authorization change.
At `c866e6b0`, both node types pass the real `events.list_event_logs` private-session gate for an admin-owned Slack-event run.
The deterministic provider calls a test action that invokes the real receipt action with its unchanged engine-built context.
The test persists a run with `slack.message` and `refs.channel = CPRIVATE` through the normal workflow store.
It dispatches through the normal Runtime or Thread engine bridge. It does not simulate webhook signature or channel-membership admission.
The returned action result has `success: true`. This proves gate passage, including the organization-admin check, with empty receipt storage.
It does not prove disclosure of a particular production receipt or a team-owned execution bypass.

[`event-log-privacy.test.ts`](../../packages/api/src/workflows/event-log-privacy.test.ts) records two expected failures.
Remove `fails` from `it.fails.each` and run `pnpm --filter @valet/api test event-log-privacy`.
Both cases fail at the final assertion: `expected true to be false`.
The preceding assertions establish completed execution, one action observation, and user ownership.
Investigation and a fix belong in a separate small PR. This spec PR does not select its authorization design.

## Decisions and open questions (informative)

- **Pattern / Why / Alternative rejected**: Existing workspace access model / #818 already shipped it / A second workflow access catalog.
- **Pattern / Why / Alternative rejected**: Existing workspace targeting / Preserve shipped origins and legacy mappings / A new node workspace selector.
- **Pattern / Why / Alternative rejected**: Save-only session deprecation with retained execution / Preserve definitions and active work / Automatic translation or immediate executor deletion.
- **Pattern / Why / Alternative rejected**: Existing audience carriage contract / #818 shipped audience routing; the gate repro stands separately / Rebuilding Thread audience routing here.

Open decisions: approve loss of per-step isolation and parallel agent turns, and approve node IDs replacing Runtime titles.
Script-dependent conversion remains blocked until slice 2 or an explicit author rewrite to `tool` steps.
This plan sets no deadline for deleting retained Runtime execution.

## Validation

Run `pnpm install`, `pnpm typecheck`, and `pnpm --filter @valet/workflow test`.
Run `pnpm --filter @valet/api test workflows engine-deps events/actions step-grants` without a `--` separator.
Run docs lint and the spec prose checker. Attempt `make e2e` and capture its complete output.
Report missing tools separately from test failures. Expected-failure repro cases record known defects. They do not establish a privacy fix.
