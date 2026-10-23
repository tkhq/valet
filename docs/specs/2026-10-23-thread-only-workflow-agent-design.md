# Remove Runtime from workflow authoring

Status: proposed removal plan. This PR changes no application behavior or authorization.

## Existing baseline (informative)

[PR #818](https://github.com/tkhq/valet/pull/818) shipped the personal/team assistant Thread path.
[PR #920](https://github.com/tkhq/valet/pull/920) added step `toolScope`.
Thread uses the stored discriminator `orchestrator`. Runtime uses `session`.
Engine sessions remain necessary for sandbox ownership and recovery after Runtime leaves workflow authoring.
This plan removes the workflow node choice. It does not remove engine sessions.

The following shipped contracts remain authoritative:

- [Thread execution isolation](2026-10-05-thread-execution-isolation-design.md): execution, memory scope, audience routing, and origin restrictions.
- [Legacy continuity](2026-10-06-legacy-continuity-design.md): retained runtime identities, directories, admissions, and files.
- [Thread API cleanup](2026-10-04-thread-api-cleanup-design.md): access, credentials, and recovery.
- [Agent step grants](2026-10-17-agent-step-workflow-grants-design.md): saved grants and unattended execution.

The inventory describes the checkout at `c866e6b0`, including changes after #818.
Personal/team scope access, step `toolScope`, assistant targeting, and Slack audience routing are existing behavior, outside this removal plan.

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
| V8 | Convert while an older version has active runs | Active runs MUST retain their snapshots. Preview MUST warn that old-version runs lose saved grants, or block conversion while they remain active. New runs MUST use the saved new version. |
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
| `model` | Runtime passes its optional model to primary and repair submissions. Thread has no node model field. | **Close** with a per-submission Thread model field, existing organization resolution, and repair parity. Never mutate the personal/team assistant default. |
| `title` | Runtime accepts a templated session title. Thread has no node title field. | **Drop** dedicated session titles. Conversion uses the node ID as its step label and discloses the lost title and its template references. No new thread-title mutation. |
| `mode` | Runtime supports only `start`. Thread has no mode field. | **Drop** during explicit conversion. No steer or attach replacement is needed. |
| `wait` | Runtime `none` starts parallel work in its own session. Thread submissions run in series on the run's thread. Omission waits for settlement. | **Drop** independent agent work under `none`. Shared admission machinery does not provide parallelism. Preview warns that dispatch-only success means admission, not completed work. |
| `wait.timeout` | New saves already reject timeout in `validate.ts`. Only legacy definitions carry it; the shared executor reads only `wait.mode`. | **Drop** this ineffective field. Preview flags its presence. No new timeout semantics. |
| Per-step transcript isolation | Runtime has a deterministic session per step and iteration. Thread uses the existing run/origin conversation and serial queue. | **Drop** fresh per-step conversation guarantees for converted graphs. Preview warns about shared context, serialization, and cancellation scope. |
| Foreach concurrency | Both node types are allowed as bodies. Runtime iterations have separate sessions. Thread uses the existing run/origin thread. | **Covered** for indexed results and dispatch identity. **Drop** independent agent-turn parallelism within one Thread queue. Keep non-agent concurrency unchanged. |
| Cost and usage | Runtime writes under `wf:<run>:<node>[:<iteration>]`. Thread entries live under assistant sessions. | **Covered** by `valet_usage_step_session` and usage projections. Preserve dispatch IDs, repair attribution, model reporting, and iteration totals. |
| Prompt, schema, repair | Both render templates and share submission machinery with one bounded schema-repair turn. | **Covered**. Keep `response` and `output` semantics. |
| Result identity | Both return `sessionId`. Thread also returns `threadId`. Dispatch-only results include a receipt. | **Close** conversion review of session-ID templates, URLs, script arguments, and consumers. Never synthesize a Runtime ID for Thread. |
| Model-call budget | Both pass `maxModelCalls` to primary and repair submissions. | **Covered**. Preserve the existing default and repair budget behavior. |
| Recovery and retries | Both persist intent and receipts, with deterministic primary and repair dispatch IDs. | **Covered**. Keep Runtime execution for stored graphs and snapshots. |
| Memory, skills, integrations, children, browser, attachments, artifacts | Thread already uses the personal/team assistant builder. Runtime has a narrower builder and distinct file identity. | **Covered** by shipped Thread behavior. Conversion discloses changed memory/context and publication identity. No access expansion here. |
| Scope, grants, credentials, unattended decisions | Existing host paths enforce these for both agent types. | **Covered** by current policy and step-grant contracts. Graph edits retain grant invalidation. |
| Owner, origin, reports, Slack sender | Thread refuses new team Slack-event dispatch with a separate conversation origin (`engine-deps.ts:558-561`); Runtime does not. Recorded legacy mappings retain their behavior. | **Drop** this Runtime route on conversion. Preview flags affected graphs. Other routes reuse #818 contracts; no personal/team scope selector or audience redesign. |
| Authoring and model-update tools | Canvas, templates, generated reference, imports, aggregate helpers, and `update_model` still know Runtime. | **Close** all new-authoring surfaces together. Keep legacy readers and diagnostics. |
| V1 import | `v1-convert.ts:757` and the pending-step flush near line 1100 emit `session` nodes for `import-v1-dialog.tsx`. | **Close** before the save gate: route V1 output through conversion preview, or provide a supported replacement. Otherwise V1 import cannot save. |
| Sandbox lifecycle | `sandbox-reclaim.ts` destroys `wf:` sandboxes when runs settle. Originless Thread runs allocate per-run executions (`engine-deps.ts:606-608`); archive only evicts the cache and keeps files (`run-attention.ts:422-431`). | **Close**: assign reclaim ownership and retention rules before high-frequency scheduled graphs convert. Cache eviction is not sandbox destruction. |
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
Repository sync MUST retain the last valid saved graph and report the rejected file.
The save gate MUST NOT silently disable that graph's triggers or a caller's triggers. Implementation MUST resolve the rejected-child policy before rollout (slice 6).
Read/export paths MUST retain legacy fields. Exported Runtime files require conversion before reimport under the new save gate.

This PR requires no schema change. Later schema changes MUST edit `0000` in place and include applicable repair and reset steps.
Executor deletion needs a separate retirement decision after all saved Runtime graphs and resumable snapshots have explicit dispositions.
Elapsed time alone cannot establish safe deletion.

## Implementation slices (informative)

1. **Thread model parity:** Extend node types, `ALLOWED_KEYS.orchestrator`, validation, templating, dispatch, repair, `update_model`, editor, and generated reference.
   Extend `ui.defaultModel` propagation in `editor-model.ts:355` to Thread nodes.
   Check invalid/disallowed models, omitted defaults, per-item isolation, repair, and concurrent runs. Do not rebuild personal/team assistant routing.
2. **Script migration:** Specify and implement Thread sandbox-action step admission in a separate reviewed PR.
   Test forged, stale, concurrent, settled, cross-owner, and widened-scope requests, plus valid calls and idempotent retries.
   Keep current Runtime admission. This removal spec grants no new authorization.
3. **Conversion preview:** Show removed `mode`, templated `title` references, legacy timeout fields, file dependencies, changed isolation, and result-identity dependencies.
   Warn about serialized foreach/`wait: none` work and refused team Slack-event/conversation-origin combinations.
   `step-grants.ts:85` requires `sameWorkflowSteps`: conversion removes saved-grant eligibility from active old-version runs despite retained snapshots.
   Warn about this loss or block conversion until those runs settle (V8).
   Preserve node IDs, edges, prompts, schemas, scopes, budgets, and supported wait modes. Require explicit confirmation.
4. **Authoring gate:** Remove Runtime from creation menus, templates, examples, and generated guidance.
   Add one save-only refusal across API create/update/copy/patch, aggregate helpers, file import, and repository sync.
   Ship after model and script dependencies have a supported disposition. Keep legacy editing visible and explain conversion before graph saves.
5. **V1 import:** Update `v1-convert.ts` and `import-v1-dialog.tsx` before enabling the save gate.
   Preserve the import checklist and require review of lost parallelism, titles, files, and unsupported dependencies.
6. **Repository sync:** Separate unchanged legacy mirrors from new definition writes before enabling the gate.
   `ContentSyncService` skips body validation when the head/discovery stamp or manifest matches. Unchanged files are not re-checked on every poll.
   A changed manifest or forced resync revalidates all candidate bodies, including unchanged Runtime files, before comparing each mirror's `contentSha`.
   Today, `workflow-collector.ts:285-290` maps rejected files to `null` for call validation.
   `teamTriggerGate` (lines 824-849) can then disable a caller's trigger even though the rejected child retains its saved graph.
   Proposed default: exempt unchanged saved Runtime mirrors by blob identity from the definition-write gate. Confirm the recheck policy before rollout.
   If rollout requires revalidation, invalidate both sync comparisons once by gate version, not on every poll.
   Persist rejection diagnostics by source/path/blob and gate version. Keep the warning visible without emitting it again on each poll.
   Do not mark permanent validation failures as deferred readiness checks, which retry unchanged content.
   Test unchanged polls, forced resync, unrelated file edits, rejected children, and caller triggers. The caller policy remains open.
7. **Thread sandbox lifecycle:** Name one reclaim owner and define settlement, background-work, file-retention, and recovery rules.
   Verify created/deleted accounting and retained-file access. Land this slice before converting high-frequency scheduled graphs.
8. **Compatibility verification:** Exercise V1 through V9 with saved definitions, active versions, schedules, parked submissions, repairs, and retained files.
   Keep Runtime execution, diagnostics, usage attribution, and reclaim code until the separate retirement decision.

## Event-log privacy repro (informative)

The repro is independent of Runtime removal. This PR includes and specifies no authorization change.
[`event-log-privacy.test.ts`](../../packages/api/src/workflows/event-log-privacy.test.ts) documents current behavior, not an access-policy decision.
It uses normal tests for `session` and `orchestrator`, with no expected-failure wrapper.
Each test starts an admin-owned user run through `workflowRunHost.start`, the interpreter, and the real node executor.
The run uses the dispatcher's event-input shape, computed `definitionVersionId`, and `refs.channel = CPRIVATE`, without a conversation origin.
The test injects the production `events-actions` plugin because the integration harness omits it.
The faux model calls `events.list_event_logs` through `call_tool`, not a proxy test action.
The tool result contains the seeded receipt ID and `channelId = COTHERPRIVATE`, a different private channel, with `hasMore: false`.
Setup, completed execution, checkpoint output, and tool-result count assertions run in the same normal test.
Temporarily inverting only the final receipt assertion must fail both cases at that assertion.
The fixture does not test webhook admission, channel membership, message payload disclosure, or production receipt contents.

Scope: team-owned contexts already fail `transcriptIsShared`; only user-owned contexts pass its owner check.
The tested user is an organization admin. Non-admin users still fail the admin check.
The [isolation contract, line 13](2026-10-05-thread-execution-isolation-design.md?plain=1#L13) defines Slack-event memory scope and origin restrictions.
[Run audience routing](../../packages/api/src/workflows/run-attention.ts#L62) carries the event channel for approval attention;
[failed-run routing, lines 114-122](../../packages/api/src/workflows/run-attention.ts#L114-L122) also resolves that channel's audience.
Should a channel-started, user-owned run count as a shared context for admin-only event diagnostics? This plan does not decide.
Any access-rule change belongs in a separate PR. Flip the current-behavior assertion when that rule changes.

## Decisions and open questions (informative)

| Pattern | Why | Alternative rejected |
| --- | --- | --- |
| Existing personal/team scope access model | #818 already shipped it | A second workflow access catalog |
| Existing assistant targeting | Preserve shipped origins and legacy mappings | A new personal/team scope selector |
| Save-only session deprecation with retained execution | Preserve definitions and active work | Automatic translation or immediate executor deletion |
| Existing audience carriage contract | #818 shipped routing; the access test documents current behavior separately | Rebuilding Thread audience routing here |

Open questions:

1. Should a user-owned, channel-started run count as a shared context for admin-only event diagnostics?
2. Is losing parallel agent work in `foreach` and `wait: none` acceptable, or should removal wait for per-step isolated Thread executions?
3. Who owns sandbox reclaim for per-run Thread executions?
4. Should conversion be blocked while the old version has active runs?
5. Should unchanged mirrored Runtime files be re-checked on each sync, and should a rejected child keep its caller's trigger on?
6. Is replacing templated Runtime titles with node IDs acceptable?

Script-dependent conversion remains blocked until slice 2 or an explicit author rewrite to `tool` steps.
This plan sets no deadline for deleting retained Runtime execution.

## Validation

Run `CI=true pnpm install --frozen-lockfile`, `pnpm typecheck`, and `pnpm --filter @valet/workflow test`.
Run `pnpm --filter @valet/api test workflows engine-deps events/actions step-grants event-log-privacy` without a `--` separator.
Confirm `event-log-privacy` passes. Temporarily invert its final receipt assertion, confirm failure only there, then revert and rerun.
Run `python3 scripts/docs/ste_lint.py docs/specs/2026-10-23-thread-only-workflow-agent-design.md` for spec prose.
`docs_lint.py` does not scan `docs/specs/`.
Run `node scripts/ci/changelog_commit_guard.mjs --base origin/dev-v2 --head HEAD`.
Run `python3 scripts/docs/pr_description_lint.py` with the PR body on standard input.
Attempt `make e2e` and capture its complete output. Report missing tools separately from test failures.
The access test documents current behavior. It does not establish a privacy fix.
