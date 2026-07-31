# Workflow Rendering in Chat + V2 Workflow List UI — Design

**Date:** 2026-07-31
**Status:** Approved (brainstorm output; implementation plan to follow in `docs/plans/`)
**Branch context:** dev-v2 (V2 DAG workflow engine in `packages/workflow` + `packages/api`)

## Problem

V1 taught us that users rarely open the dedicated workflows UI and never used the
workflow co-pilot. They stay in the orchestrator / session chat and ask the
orchestrator to create and manage workflows, because the orchestrator holds the
business-process context. But workflow tool outputs currently render as generic
JSON cards, so users can't see what the orchestrator built.

Goal: meld the workflow experience into the orchestrator and session chat UI by
rendering workflow tool outputs as node diagrams — inline in chat, expandable to
a drawer — plus a lightweight V2 list/detail UI for browsing workflows and runs.

## Decisions (locked during brainstorm)

1. **Interactivity:** viewer + light edits. No comprehensive visual editor.
2. **Placement:** compact inline card in chat, expanding into the existing
   session drawer panel system.
3. **Scope:** definitions AND run status — execution tools overlay per-node run
   state on the same diagram; approval gates are actionable from the diagram.
4. **Format:** V2 DAG only (`WorkflowDefinition` `dag/v1` nodes + edges from
   `@valet/workflow`). V1 step-array outputs keep falling through to the
   generic tool card.
5. **Tech:** `@xyflow/react` (React Flow) + `elkjs` auto-layout. Mermaid and
   custom-SVG approaches were considered and rejected (read-only dead end;
   reinventing pan/zoom/hit-testing respectively).
6. **Added scope:** a V2 workflow list + detail UI (read-only / light edits),
   replacing the current `/workflows/*` redirect routes. V1 `/automation` UI
   stays untouched.

## 1. Data flow

- Workflow tool outputs carry **identifiers** (`workflowId`, `runId?`) plus a
  short text summary. The chat card fetches current state via React Query
  against the V2 API (`GET /api/workflows/:id`,
  `GET /api/workflows/:id/runs/:runId`) instead of parsing tool output blobs.
  Cards therefore always show the workflow as it exists now, even after later
  edits.
- **Tool contract check:** the OpenCode workflow tools (`docker/opencode/tools/`)
  must include V2 ids in their outputs. Tools that don't yet are updated as part
  of this work (small, tool-side change; requires `IMAGE_BUILD_VERSION` bump).
- **Run status freshness:** while a run is non-terminal, the card/drawer polls
  the run endpoint (~3s interval). Wiring run updates into the session event
  stream is an explicit follow-up, not part of this slice.

## 2. Components

New shared module `packages/client/src/components/workflow-canvas/`:

| Piece | Responsibility |
|---|---|
| `WorkflowCanvas` | React Flow wrapper. Props: `definition: WorkflowDefinition`, `runState?`, `mode: 'preview' \| 'full'`. Preview = non-interactive, fit-to-view. Full = pan/zoom/select/drag. |
| `nodes/` | Custom node components for the 11 DAG node types, in visual families: **trigger**, **action** (tool/session/orchestrator/llm), **control** (if/foreach/wait/stop), **gate** (approval), **data** (set). |
| `lib/` | Pure functions: DAG → React Flow graph mapping; `elkjs` auto-layout fallback when `definition.ui` has no positions; run state → per-node status mapping. Unit-testable without rendering. |

Chat integration:

- `packages/client/src/components/chat/tool-cards/workflow-card.tsx`,
  registered in `resolveToolCard()` (`tool-cards/index.tsx`). Compact card:
  workflow name, status chip, ~240px preview canvas. Click opens the drawer.
- New `'workflow'` member of the `DrawerPanel` union in
  `packages/client/src/routes/sessions/$sessionId.tsx`, with a lazy-loaded
  `WorkflowDrawer` (same pattern as `FilesDrawer`/`ReviewDrawer`). Drawer =
  full-mode canvas + right-hand **inspector** for the selected node.

## 3. Light edits

Allowed: workflow rename/description, enabled toggle, node param edits (typed
inspector form per node type), node position drags (persisted to
`definition.ui` / `WorkflowEditorState`). Writes go through the existing V2
workflow update endpoint with optimistic React Query updates.

Not allowed (stays conversational via the orchestrator): adding/removing nodes,
creating/deleting edges, changing node types.

## 4. Run overlay + approvals

- Per-node run states derived from the run row + checkpoints:
  `pending / running / succeeded / failed / skipped / waiting`.
- Approval nodes in `waiting` render Approve/Reject actions in both the inline
  card and the drawer inspector, calling the existing approval resolution
  endpoint (`packages/api/src/routes/workflows.ts:350`).

## 5. Visual direction

Sits inside the existing Radix/Tailwind system with a deliberate
**schematic/blueprint** identity:

- Dotted-grid canvas background with a faint radial vignette; theme-aware via
  existing tokens (dark/light).
- Node families use a single hue accent per family on a neutral node chassis.
  Monospace type for node-type labels; existing sans for node names. Legible at
  preview scale.
- Motion concentrated at high-impact moments: staggered node reveal on first
  mount, animated dash-flow along edges on the active run path, soft pulse on
  `running` nodes, spring expand on card → drawer handoff. CSS-first.
- Status encoded redundantly (color + icon badge) for accessibility.

## 6. V2 workflow list UI

The current `/workflows/*` routes are redirects into the V1 `/automation`
UI. They are repurposed as the V2 surface:

- **`/workflows`** — lists V2 `workflowDefinitions`: name, enabled toggle
  (light edit), last-run status chip, thumbnail preview canvas (`mode:
  'preview'`). Skeleton loaders per existing convention.
- **`/workflows/$workflowId`** — full-mode `WorkflowCanvas` as the primary
  surface + shared inspector, with a **Runs** panel listing `workflowRuns`
  (status, outcome, started/settled). Selecting a run overlays its node states
  on the canvas; approval gates actionable. Same light-edit scope as section 3.
- **`/workflows/$workflowId?run=<runId>`** — deep link used by chat cards
  ("open full view") and run list rows.
- New client API module(s) in `packages/client/src/api/` for V2 endpoints with
  query key factories (`workflowV2Keys`, `workflowRunKeys`), separate from the
  V1 `workflows.ts`.
- Sidebar nav entry points at `/workflows`. V1 `/automation` remains untouched
  until V1 retires.

## 7. Errors & fallbacks

- Fetch 404 (workflow deleted) → card degrades to a textual summary from the
  tool output snapshot.
- Invalid/cyclic DAG → render the layoutable subset + a validation notice.
- V1 step-array tool outputs → untouched; generic card.

## 8. Dependencies

- `@xyflow/react` (~45kb gz) and `elkjs` added to `packages/client`.
- Client imports `WorkflowDefinition`/node/edge types from `@valet/workflow`
  (workspace dependency).

## 9. Testing

- Vitest unit tests for `workflow-canvas/lib/` pure functions: graph mapping,
  layout fallback, run-state mapping.
- `resolveToolCard()` routing test for workflow tool names.
- Manual verification in the running client (orchestrator creates a workflow →
  inline card renders → drawer opens → run overlay updates → approval works).
- `cd packages/client && pnpm build` before commit (stricter than typecheck).

## Out of scope

- Comprehensive visual editing (node/edge authoring).
- Session event-stream push for run status (polling first; push is follow-up).
- Rendering V1 step-array workflows as diagrams.
- Retiring or modifying the V1 `/automation` UI.
