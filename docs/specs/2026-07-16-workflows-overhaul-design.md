# Workflows Overhaul Design — chat-first authoring, live runs in chat, triggers

**Date:** 2026-07-16
**Status:** Draft
**Scope:** Agent-facing workflow tools (chat-first authoring), inline workflow rendering in chat (proposed definitions and live run cards), webhook + schedule triggers, targeted executor additions (run-status bus events, per-node error policy), and the dag/v1 rewrite of `docs/specs/workflows.md`. The execution core (interpreter, checkpoints, signals, leases) was audited and is kept as-is.

## Context

The v2 execution core is solid and dogfooded: `dag/v1` definitions (11 node types incl. first-class `approval`, `foreach`, `llm`, `orchestrator`, `tool` — `packages/workflow/src/dag/`), a portable checkpointed interpreter (`interpreter.ts`, no replay — node results are checkpoint rows), durable `workflow_signals` (approvals/cancel, at-most-once), CAS claim + lease run ownership, a React Flow editor (`packages/web/src/components/workflows/editor/`), and a run-detail page (checkpoint list, 5s polling).

The gaps are around it:

- **The agent has no workflow tools.** `packages/plugin-workflows` ships only a skill — and it's stale *legacy* content instructing the agent to call tools that don't exist in v2 (`sync_workflow`, steps-based definitions, WorkflowExecutorDO). The only real surface is HTTP (`packages/api/src/routes/workflows.ts`), consumed by the web app.
- **Chat is workflow-blind.** A run's only chat presence is the generic signal envelope on the `signal:workflow:{runId}` thread (`workflow.request` from the `orchestrator` node); approvals surface via the bell + run-page deep link. No node graph exists anywhere in session UI. Meanwhile the tool-renderer registry (`packages/web/src/components/session/tool-renderers/index.ts`, first-match array with mandatory-last fallback) is a purpose-built extension point, and `tool_call` wire parts deliver `args`/`result` with structured fields intact.
- **Triggers are manual-only** — webhook/schedule were explicitly out of scope in the nodes+editor pass.
- **Spec drift:** `docs/specs/workflows.md` still documents the legacy steps/DO system; the v2 definition format lives only in code and plans.

## Decisions (locked)

1. **Agent workflow tools in `packages/plugin-workflows` (the authoring foundation).** The plugin gains actions: `list_workflows`, `get_workflow`, `create_workflow`, `update_workflow`, `run_workflow`, `get_run`, `cancel_run` — thin wrappers over the same code paths the HTTP routes use (definition persistence via the definition-version module; `validateWorkflowDefinition` on every write, **validator errors returned as the action result** so the agent self-corrects in-loop instead of failing opaquely). Results are structured, not prose: `create/update/get_workflow` return `{ workflowId, name, definition }` (full dag/v1); `run_workflow` returns `{ runId, workflowId, status }`; `get_run` returns the run-detail shape (status, checkpoints, pending approvals). Risk levels: `create_workflow`/`update_workflow`/`cancel_run` declare `riskLevel: "high"` (gate by default under the policy engine — and pre-policy, under the existing risk-default derivation), reads and `run_workflow` are `medium`. The skill is **rewritten** for dag/v1: node-type reference, edge semantics (`fromOutput` branches, `when` guards), authoring patterns (trigger root, stop nodes, foreach bodies), and "propose small, validate, iterate."

2. **One inline workflow component, three mounts.** A compact **read-only DAG view** shared by (a) the workflow tool renderer, (b) approval-gate context (a pending `create/update_workflow` gate renders the *proposed* graph from the gate's action args), and (c) the workflow signal card. Implementation: reuse `editor-model.ts`'s definition→layout conversion (BFS auto-layout, `NODE_META` icons/colors) but render as lightweight SVG + positioned divs — **not** a React Flow instance per message (transcripts can hold dozens; React Flow stays the editor's). Node pills: type icon + label; if/approval show labeled true/false edges; unknown future node types render as generic pills (forward-compat). Every mount gets an "Open in editor" / "Open run" deep link. Collapsed by default above 12 nodes.

3. **Chat tool renderer.** A `workflow` `ToolRenderer` registered before the fallback, matching the plugin's action names as dispatched (the plugin-catalog path — matcher covers the persisted tool names for both direct and `call_tool`-wrapped forms). Category `generic` strip, workflow icon, `formatTarget` = workflow name, `formatSummary` = node count / run status. Body: the DAG view (decision 2) from `result.definition` (or `args.definition` while running/gated); for `run_workflow`/`get_run`, the live run card (decision 4).

4. **Live run cards.** The run card = the same mini-DAG overlaid with per-node status (pending / running / succeeded / failed / waiting-approval) + a compact event line (started, elapsed, current node). Data: the existing `GET /api/workflows/runs/:runId` via `useRunDetail` polling (5s, stops on settle) — same as the run page, no new push machinery this pass (decision 7's bus event is the future upgrade path). **Approval nodes render inline approve/deny buttons** calling the existing approvals route; resolution updates the card and (per the notification wiring that exists) clears the bell item. Failures expand to the failing node's checkpoint error. The generic signal envelope upgrades: when a signal thread is `signal:workflow:{runId}`, the signal card embeds this run card instead of the bare envelope.

5. **Webhook triggers.** Trigger node config becomes a tagged union: `{ type: "manual" } | { type: "webhook" } | { type: "schedule", cron }` (manual is today's behavior and the migration default for existing definitions — additive, old definitions valid). Webhook: `POST /api/hooks/workflows/:workflowId/:hookId` — `hookId` is a per-workflow opaque secret minted when the trigger type is set (regenerable in the editor; constant-time compare; **unauthenticated route by design** — the secret URL is the credential, matching webhook convention), JSON body becomes run `params` (size-capped 64KB), response `{ runId }` (202). Rate limit per workflow (in-memory, coarse). Plugin `TriggerDef` events (`verify → toSignal`) can also start workflow runs — the ingress route plumbing is shared with the channel host built by the Telegram spec; **channel-event triggers** ("when a Telegram message arrives") are the named follow-on once that transport ships: the seam (a `toSignal` result carrying a workflow target) is designed here, not built.

6. **Schedule triggers.** Cron expression (5-field, validated on save) on the trigger node. A host-side sweep (registered with the same periodic authority as event-retention pruning — one timer brain, restart-safe) computes due workflows from a per-workflow `last_fired_at` watermark: fire → start run with `params = { scheduledFor }` → advance watermark; missed windows while the api was down fire **once** (not per missed slot). Overlap policy: **skip if a run of this workflow is still active** (recorded in the run row as `skipped_overlap` telemetry-visible; configurable policies later). Schedules pause when the workflow definition is invalid or the trigger type changes.

7. **Executor: audited — kept; two targeted additions.** The audit against the goals above found no blocking gaps in the interpreter/checkpoint/signal/lease model (parking, approvals, foreach, tool dedup all carry the new surfaces unchanged). Additions:
   - **`workflow_run_status` bus events** emitted by the api run host on run transitions (started, node succeeded/failed, waiting-approval, settled) — additive engine-bus event type consumed by the telemetry projector (Value/Events tabs) and, later, by run cards to replace polling. Not required for this pass's UI.
   - **Per-node `onError: "fail" | "continue"`** (default `fail`, today's behavior) — the one expressiveness gap chat-authored automation hits immediately ("notify me but keep going"). `continue` records the failed checkpoint and proceeds along the normal edge with the node's output set to an error object. Retries/backoff stay out.

8. **Spec-drift fix in the same pass.** `docs/specs/workflows.md` is rewritten for v2: dag/v1 definition format, node-type reference, trigger types, run lifecycle, pointers to the run-host spec for execution internals, and an explicit "legacy steps system" tombstone pointing at the frozen worker. The stale skill content dies with decision 1.

9. **Editor stays the power tool.** Chat-first authoring is the primary *entry* path; the React Flow editor remains the surface for precision work (it also gains the trigger-type + hook-secret + cron fields, and `onError` in the node inspector). No editor rework beyond those fields.

## Exit criteria (the dogfood)

In chat: "make a workflow that runs every morning at 8, checks <something> with a tool, and asks my approval before posting" → agent proposes via `create_workflow`, the approval gate renders the node graph inline, approve → saved and visible in the editor with correct trigger fields. "Run it now" → live run card animates node-by-node, the approval node's approve/deny buttons work inline, and the run settles on the card without leaving chat. A failing tool node with `onError: continue` proceeds and shows the failed pill. `curl` to the hook URL starts a run (bad secret → 404, no oracle). The schedule fires next morning exactly once (verified by watermark + single run row) and skips while a run is still active. `docs/specs/workflows.md` describes the system that actually exists.

## Testing

- **Actions:** each action against the real store (PGlite) — create/update round-trip with validator-error results on invalid definitions, run/cancel/get_run shapes; risk-level metadata pinned.
- **DAG view:** pure layout snapshot tests over representative definitions (branches, foreach, 12+-node collapse); renders from both `args` and `result`; unknown node type → generic pill.
- **Run card:** poll-driven status transitions from fixture run details; inline approval round-trip; failure expansion.
- **Webhook:** secret compare (timing-safe), params capping, rate limit, 404-on-bad-secret, run started with params.
- **Schedule sweep:** watermark math (due/not-due, missed-window fires once, DST-agnostic UTC), overlap skip, restart-safety (recompute from store).
- **Executor additions:** `onError: continue` interpreter tests (checkpoint recorded, edge followed, output shape); `workflow_run_status` emission pinned; **existing workflow conformance suite untouched and green** — the audit's "kept as-is" claim is enforced by the suite.
- **Skill:** authoring e2e (real model, gated like other live e2e): prompt → valid dag/v1 created via the tools.

## Non-goals

- Executor rework beyond decision 7 (no retries/backoff, no parallel fan-out changes, no sub-workflows).
- Channel-event triggers (seam designed, built after the Telegram transport ships).
- Push-updated run cards (polling this pass; `workflow_run_status` is the upgrade path).
- Version-history UI and run-detail graph overlay on the workflow pages (chat gets the graph first; the run page keeps its checkpoint list).
- Workflow marketplace/templates, import/export.
- Editing workflows from Telegram/CLI (they get gate approve/deny like everything else; authoring UX is chat + editor).

## Addendum (2026-08-14): trigger input schema drives the run form

The manual-trigger path now enforces the trigger node's `dataSchema`
(`Record<string, WorkflowInputDefinition>`: `type`, `required`,
`default`, `description`, `enum`).

- `resolveTriggerInput(schema, input)` (`@valet/workflow`,
  `dag/trigger-input.ts`) merges defaults, then validates required
  fields, primitive types, and enum membership. `triggerDataSchema`
  extracts the schema from an unknown stored definition. Both are pure
  and shared by the api and the web client.
- `startWorkflowRun` runs the resolver. Invalid input returns
  `{ invalidInput }`; `POST /api/workflows/:id/runs` maps it to 400 with
  per-field messages, and the `workflows.start_run` action returns the
  same messages as its error result. The defaulted input becomes
  `trigger.data`.
- The web Run buttons (index row and editor header) open
  `RunWorkflowDialog` when the schema declares at least one input; the
  dialog generates one field per entry (string/enum → text/select,
  number → number, boolean → checkbox, object/array → JSON), pre-fills
  defaults, and validates with the same resolver before submit. With no
  declared inputs, Run starts immediately as before.
- The editor inspector's trigger form edits `dataSchema` (add, rename,
  remove; per-type default control; comma-separated allowed values for
  strings).

Webhook/schedule/event trigger payloads are not validated against
`dataSchema` in this pass — manual runs only.

## 2026-08-10 addendum: triggers + team-owner surface in the web UI

The editor page gains a Triggers drawer (`packages/web/src/components/
workflows/triggers-drawer.tsx`) — the first UI over two trigger APIs that
were HTTP/agent-only before:

- **Webhook:** mint, copy, rotate, and delete the arbitrary-URL trigger
  (decision 5). Rotate and delete confirm before acting because the URL
  carries the bearer secret.
- **Schedules:** new routes `GET/POST /api/workflows/:id/schedules` and
  `DELETE /api/workflows/:id/schedules/:scheduleId` over the existing
  `schedule-service.ts`. The routes resolve the workflow through
  `getWorkflowDefinition` first (own-rows 404 convention), and a delete
  requires the schedule to belong to that workflow. The service also
  carries orchestrator-prompt schedules; this surface manages only the
  workflow-scoped kind.

The New-workflow dialog takes its owner from the nav's active workspace
(`CreateWorkflowRequest.teamId` existed on the wire but had no UI). It
carries no Owner select of its own: a second control would duplicate the
workspace switcher and could contradict it. The workflows list badges
team-owned rows with the team name. `TeamSummary` gains `callerRole` so
the teams settings panel can hide mutation controls the API's
`canAdministerTeam` gate would 404 anyway.
