# Workflow Chat Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the V2 orchestrator agent workflow tools, render their outputs as DAG diagrams in chat, overlay run status on the canvas, and deliver a running local k8s env plus a smoke-test prompt.

**Architecture:** A `workflows` ActionPlugin defined in `packages/api` (closed over the workflow store/run host providers) exposes CRUD/run tools to the agent via the plugin catalog (`list_tools`/`call_tool`). A read-only `WorkflowPreview` component in `packages/web` reuses the existing editor-model `toFlow()` + `FlowNode`. A chat tool renderer matches `call_tool` invocations whose `tool_id` starts with `workflows.`, fetches current state by id, and renders the preview + approval actions. Run detail gains a canvas with per-node status.

**Tech Stack:** TypeScript, Hono, Drizzle/Postgres, TypeBox, React 19, `@xyflow/react` v12, TanStack Query/Router, vitest. Deployed locally via Rancher Desktop + Helm (`make k8s-build && make k8s-up`).

**Spec:** `docs/specs/2026-07-31-workflow-chat-rendering-design.md` (see Addendum — targets `packages/web`/`packages/api`, not `packages/client`).

**Grounding facts (verified on dev-v2):**
- Plugin catalog: `packages/engine/src/plugin-catalog.ts` — `ActionPlugin { service, actions: PluginAction[] }`; `PluginAction { id, name, description, riskLevel, parameters: TSchema, execute(args, ctx) => Promise<PluginActionResult> }`; `PluginActionResult { success, data?, error? }`. Actions surface to the LLM through `list_tools` + `call_tool({ tool_id, params, summary })`.
- `ValetPlugin.actions?: ActionPlugin[]` (`packages/engine/src/valet-plugin.ts:219`). `packages/api/src/plugins/assemble.ts` builds catalog tools from action plugins; `packages/api/src/plugins/registry.gen.ts` imports `@valet/plugin-workflows/plugin` (currently skill-only).
- Workflow providers live in `packages/api/src/main.ts` scope: `providers.workflowStore`, `providers.workflowRunHost` (`startHost()` at main.ts:219). Routes in `packages/api/src/routes/workflows.ts` show canonical usage: definitions table via Drizzle + `rowToDefinition`, run start via `workflowRunHost.start`, run read via `workflowStore.getRun` + checkpoints + signals.
- Web tool renderers: `packages/web/src/components/session/tool-renderers/` — registry in `index.ts` (`RENDERERS` array, first match wins, fallback last), contract in `types.ts` (`matches: string | string[] | ((toolName) => boolean)`), call site `message-item.tsx:85` (`pickRenderer(part.toolName)`).
- Editor model: `packages/web/src/components/workflows/editor-model.ts` — `toFlow(definition): WorkflowFlowState`, `isWorkflowDefinitionShape()`. Canvas: `editor/canvas.tsx` (interactive, editor-only), `editor/flow-node.tsx` exports `FlowNode`, `FlowNodeData`, `FlowXyNode`.
- Web API hooks: `packages/web/src/api/workflows.ts` — `useWorkflow(id)`, `useRunDetail(runId)` (polls 5s until settled), `useResolveApproval(runId)`, `qkWorkflows` key factory. Wire types from `@valet/api/wire`.
- Run detail route `packages/web/src/routes/workflows.runs.$runId.tsx` renders status bar + `ApprovalCard` + checkpoint list; `run-detail-helpers.ts` has `findPendingApproval(waitingOn)`, `findApprovalPrompt(definition, nodeId)`.
- k8s env: `make k8s-sandbox-install` (once), `make k8s-build` (images `valet-api:dev` incl. bundled web, `valet-sandbox:dev`), `make k8s-up` (helm upgrade --install to rancher-desktop), `make k8s-logs`.

---

### Task 1: Workflow service helpers shared by routes and actions

**Files:**
- Create: `packages/api/src/workflows/service.ts`
- Modify: `packages/api/src/routes/workflows.ts` (extract, no behavior change)
- Test: `packages/api/src/workflows/service.test.ts` (only if extraction produces pure logic; otherwise covered by existing route tests)

- [ ] **Step 1: Read `packages/api/src/routes/workflows.ts` fully.** Identify the bodies of: list (GET /), get (GET /:id), create (POST /), update (PUT /:id), start run (POST /:id/runs), get run detail (GET /runs/:runId). Note owner-scoping (`c.var.user`) and `rowToDefinition`.

- [ ] **Step 2: Extract owner-scoped functions into `service.ts`** with signatures like:

```typescript
export interface WorkflowServiceDeps {
  db: DrizzleDb;                       // same type routes use
  workflowStore: WorkflowStore;
  workflowRunHost: RunHost;            // same type providers expose
}
export async function listWorkflowDefinitions(deps, owner): Promise<WorkflowDefinitionSummary[]>
export async function getWorkflowDefinition(deps, owner, id): Promise<WorkflowDefinitionSummary | null>
export async function saveWorkflowDefinition(deps, owner, input: { id?: string; name?: string; definition: unknown }): Promise<WorkflowDefinitionSummary>  // create when no id; validates via validateWorkflowDefinition from @valet/workflow
export async function startWorkflowRun(deps, owner, workflowId, input?): Promise<{ runId: string; status: string }>
export async function getWorkflowRunDetail(deps, owner, runId): Promise<GetWorkflowRunResponse | null>
```

Reuse the exact route logic — move, don't rewrite. Routes call these helpers.

- [ ] **Step 3: Typecheck + run existing api workflow route tests.**

Run: `cd packages/api && pnpm typecheck && pnpm vitest run src/routes/workflows`
Expected: PASS, no behavior change.

- [ ] **Step 4: Commit** — `git commit -m "Extract workflow service helpers from routes"`

### Task 2: `workflows` ActionPlugin for the V2 agent

**Files:**
- Create: `packages/api/src/workflows/actions.ts`
- Modify: wherever `EngineHostOpts.plugins` is assembled in `packages/api/src/main.ts` (append the workflows ActionPlugin to the loaded plugin set)
- Modify: `packages/plugin-workflows/skills/workflows.md` (rewrite for V2 DAG tools)
- Test: `packages/api/src/workflows/actions.test.ts`

- [ ] **Step 1: Write failing test** for the action plugin factory:

```typescript
import { describe, expect, it } from "vitest";
import { workflowsActionPlugin } from "./actions.js";

describe("workflowsActionPlugin", () => {
  it("exposes the five workflow actions with workflows.* ids", () => {
    const plugin = workflowsActionPlugin({} as never);
    expect(plugin.service).toBe("workflows");
    expect(plugin.actions.map((a) => a.id).sort()).toEqual([
      "workflows.get_run",
      "workflows.get_workflow",
      "workflows.list_workflows",
      "workflows.save_workflow",
      "workflows.start_run",
    ]);
  });
  // + an execute test per action using the in-memory WorkflowStore
  // (packages/workflow/src/memory-store.ts) and a stub RunHost/db,
  // asserting result.data carries { workflowId } / { runId }.
});
```

Run: `cd packages/api && pnpm vitest run src/workflows/actions` — expect FAIL (module missing).

- [ ] **Step 2: Implement `workflowsActionPlugin(deps: WorkflowServiceDeps & { owner: ... })`.** Shape (TypeBox params, low/medium risk):

```typescript
import { Type } from "@sinclair/typebox";
import type { ActionPlugin } from "@valet/engine";
import { validateWorkflowDefinition } from "@valet/workflow";
import * as svc from "./service.js";

export function workflowsActionPlugin(deps: Deps): ActionPlugin {
  return {
    service: "workflows",
    description: "Create, inspect, and run Valet DAG workflows.",
    actions: [
      {
        id: "workflows.list_workflows", name: "List workflows", riskLevel: "low",
        description: "List workflow definitions for this user.",
        parameters: Type.Object({}),
        execute: async (_a, ctx) => ({ success: true, data: { workflows: await svc.listWorkflowDefinitions(deps, ownerFrom(ctx)) } }),
      },
      {
        id: "workflows.get_workflow", name: "Get workflow", riskLevel: "low",
        description: "Fetch a workflow definition (DAG nodes + edges) by id.",
        parameters: Type.Object({ workflow_id: Type.String() }),
        execute: async (a, ctx) => { /* svc.getWorkflowDefinition; success:false + error when null */ },
      },
      {
        id: "workflows.save_workflow", name: "Save workflow", riskLevel: "medium",
        description: "Create or update a workflow. definition MUST be a dag/v1 object: { version:'dag/v1', nodes:[...], edges:[...] }. Validated before save. Returns { workflowId }.",
        parameters: Type.Object({
          workflow_id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          definition: Type.Unknown(),
        }),
        execute: async (a, ctx) => { /* validateWorkflowDefinition → errors as success:false; svc.saveWorkflowDefinition → data: { workflowId: row.id, name: row.name } */ },
      },
      {
        id: "workflows.start_run", name: "Start workflow run", riskLevel: "medium",
        description: "Start a run of a workflow. Returns { runId, workflowId }.",
        parameters: Type.Object({ workflow_id: Type.String(), input: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
        execute: async (a, ctx) => { /* svc.startWorkflowRun → data: { runId, workflowId: a.workflow_id, status } */ },
      },
      {
        id: "workflows.get_run", name: "Get workflow run", riskLevel: "low",
        description: "Fetch run status, per-node checkpoints, and pending approvals. Returns { runId, workflowId, status, ... }.",
        parameters: Type.Object({ run_id: Type.String() }),
        execute: async (a, ctx) => { /* svc.getWorkflowRunDetail → data: { runId, workflowId, status, outcome, waitingOn, checkpoints } */ },
      },
    ],
  };
}
```

Owner scoping: derive owner from `ctx.userId`/`ctx.orgId` exactly the way `routes/workflows.ts` derives it from `c.var.user` — inspect and mirror; do NOT invent a new owner shape.

- [ ] **Step 3: Wire into the host.** In `packages/api/src/main.ts` (or `plugins/assemble` call site), after `providers` exist, append a synthetic ValetPlugin `{ name: "workflows-actions", version: "0.1.0", actions: [workflowsActionPlugin({ db, workflowStore: providers.workflowStore, workflowRunHost: providers.workflowRunHost })] }` to the plugin list passed to the engine host. Keep `@valet/plugin-workflows` (skill) loaded as-is.

- [ ] **Step 4: Rewrite `packages/plugin-workflows/skills/workflows.md`** for V2: dag/v1 definition shape (11 node types, edges with `fromOutput`/`when`), the five `workflows.*` tools invoked via `list_tools`/`call_tool`, approval flow (approval node → run parks → user approves in UI), and remove all V1 content (steps arrays, proposals, resume tokens, sync_trigger). Keep it under ~120 lines.

- [ ] **Step 5: Tests + typecheck pass.**

Run: `cd packages/api && pnpm vitest run src/workflows && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "Add workflows action plugin so the V2 agent can manage DAG workflows"`

### Task 3: Read-only `WorkflowPreview` canvas in packages/web

**Files:**
- Create: `packages/web/src/components/workflows/preview.tsx`
- Test: `packages/web/src/components/workflows/preview.test.tsx`

- [ ] **Step 1: Write failing tests** for the pure display-mode helper:

```typescript
import { describe, expect, it } from "vitest";
import { previewMode } from "./preview";

describe("previewMode", () => {
  it("is 'empty' below 2 nodes", () => expect(previewMode(1)).toBe("empty"));
  it("is 'canvas' for 2..8 nodes", () => expect(previewMode(8)).toBe("canvas"));
  it("is 'summary' above 8 nodes", () => expect(previewMode(9)).toBe("summary"));
});
```

Run: `cd packages/web && pnpm vitest run src/components/workflows/preview` — expect FAIL.

- [ ] **Step 2: Implement `WorkflowPreview`:**

```typescript
export type NodeRunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "waiting";
export function previewMode(nodeCount: number): "empty" | "canvas" | "summary" {
  if (nodeCount < 2) return "empty";
  return nodeCount <= 8 ? "canvas" : "summary";
}
export function WorkflowPreview({ definition, statusByNodeId, height = 240 }: {
  definition: WorkflowDefinition;
  statusByNodeId?: Record<string, NodeRunStatus>;
  height?: number;
}) { /* ... */ }
```

- `empty` → muted "No steps yet — ask the assistant to add actions." panel.
- `summary` → one-line strip: `"{n} nodes · trigger → … → {lastType}"`.
- `canvas` → `<ReactFlow nodes={...} edges={...} nodeTypes={{ workflow: FlowNode }} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} panOnDrag={false} proOptions={{ hideAttribution: true }}><Background /></ReactFlow>` built from `toFlow(definition)`. When `statusByNodeId` is provided, decorate node data/class per status (running = pulse accent, failed = danger ring, waiting = amber ring, succeeded = success tint, skipped = 40% opacity). Reuse `FlowNode`; if it doesn't accept a status, extend `FlowNodeData` with an optional `runStatus` and render a small badge — keep the editor's usage unaffected (optional field).
- Missing `definition.ui` positions → simple layered fallback: BFS depth from trigger → column x, index-in-layer → y (pure function `fallbackPositions(definition)`, unit-tested; do NOT add elkjs — YAGNI, the editor already persists positions and agent-created workflows get the fallback).

- [ ] **Step 3: Tests + typecheck.**

Run: `cd packages/web && pnpm vitest run src/components/workflows && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit** — `git commit -m "Add read-only WorkflowPreview canvas with run-status decoration"`

### Task 4: Chat tool renderer for workflows.* call_tool invocations

**Files:**
- Modify: `packages/web/src/components/session/tool-renderers/types.ts` (matches fn gains optional args)
- Modify: `packages/web/src/components/session/tool-renderers/index.ts` (register; pickRenderer(toolName, args))
- Modify: `packages/web/src/components/session/message-item.tsx:85` (pass `part.args`)
- Create: `packages/web/src/components/session/tool-renderers/workflow.tsx`
- Test: `packages/web/src/components/session/tool-renderers/workflow.test.ts`

- [ ] **Step 1: Failing tests** for matching + id extraction:

```typescript
import { describe, expect, it } from "vitest";
import { isWorkflowCallTool, workflowRefsFrom } from "./workflow";

describe("isWorkflowCallTool", () => {
  it("matches call_tool with a workflows.* tool_id", () =>
    expect(isWorkflowCallTool("call_tool", { tool_id: "workflows.save_workflow" })).toBe(true));
  it("rejects other call_tool ids and other tools", () => {
    expect(isWorkflowCallTool("call_tool", { tool_id: "github.create_issue" })).toBe(false);
    expect(isWorkflowCallTool("bash", {})).toBe(false);
  });
});

describe("workflowRefsFrom", () => {
  it("pulls workflowId/runId out of persisted result data", () => {
    expect(workflowRefsFrom({ text: "…", data: { workflowId: "wf1", runId: "r1" } }))
      .toEqual({ workflowId: "wf1", runId: "r1" });
  });
  it("returns empty refs while running / on malformed results", () =>
    expect(workflowRefsFrom(undefined)).toEqual({}));
});
```

Run: `cd packages/web && pnpm vitest run src/components/session/tool-renderers/workflow` — expect FAIL.

- [ ] **Step 2: Extend the matching seam (backward compatible).** In `types.ts`, change the function form to `(toolName: string, args?: unknown) => boolean` and `matches(renderer, toolName, args?)` accordingly; `pickRenderer(toolName, args?)` in `index.ts`; call site `message-item.tsx` passes `part.args`. String/array forms unchanged. **Check the persisted result shape first**: `resultText()` in types.ts documents that results may be `{ text, ...rest }` — verify how `call_tool` persists `PluginActionResult.data` (grep the engine's call_tool implementation in `plugin-catalog.ts` ~line 364 for what it returns) and write `workflowRefsFrom` against the REAL shape, not an assumed one.

- [ ] **Step 3: Implement `workflowRenderer`:**

- `matches: isWorkflowCallTool`, `category: "write"`, `Icon: Workflow` (lucide).
- `formatTarget(args)` → the `tool_id` suffix (`save_workflow`, `start_run`, …) + workflow name from params when present.
- `Body`: extract refs; while `status === "running"` or no refs → skeleton strip. With `workflowId` → `useWorkflow(workflowId)` → `WorkflowPreview definition={...}` + "last edited" hint + `<Link to="/workflows/$workflowId">Open</Link>`. With `runId` → `useRunDetail(runId)` (already polls) → `WorkflowPreview` with `statusByNodeId` from Task 5's helper + status badge + pending approval? render existing `ApprovalCard` wired to `useResolveApproval(runId)` (button disabled while mutation pending; card shows outcome once settled — never live buttons on settled runs) + `<Link to="/workflows/runs/$runId">Open run</Link>`. 404 → muted "workflow no longer exists" + `resultText` fallback.
- Register in `RENDERERS` before `fallbackRenderer`.
- Card coalescing note: web tool cards render collapsed by default (header strip only), so a burst of workflow tool calls does not stack full canvases the way the spec feared for the V1 client. Verify during the Task 6 smoke test; only add per-workflowId collapsing in `message-list.tsx` if spam is real.

- [ ] **Step 4: Tests + typecheck + web build.**

Run: `cd packages/web && pnpm vitest run && pnpm typecheck && pnpm build`
Expected: PASS (all existing renderer tests still green).

- [ ] **Step 5: Commit** — `git commit -m "Render workflows.* tool calls as DAG preview cards in chat"`

### Task 5: Run-status overlay on the run detail page

**Files:**
- Modify: `packages/web/src/components/workflows/run-detail-helpers.ts` (+ status mapping)
- Modify: `packages/web/src/routes/workflows.runs.$runId.tsx` (canvas above checkpoint list)
- Test: `packages/web/src/components/workflows/run-detail-helpers.test.ts`

- [ ] **Step 1: Failing test** for the mapping:

```typescript
import { statusByNodeId } from "./run-detail-helpers";

it("maps checkpoints + waitingOn to per-node statuses", () => {
  const s = statusByNodeId(
    { status: "parked", waitingOn: [{ kind: "approval", nodeId: "gate1" }] } as never,
    [{ nodeId: "t1", iteration: 0, status: "completed" }, { nodeId: "s1", iteration: 0, status: "failed" }] as never,
  );
  expect(s).toEqual({ t1: "succeeded", s1: "failed", gate1: "waiting" });
});
```

(Adjust field names to the REAL `GetWorkflowRunResponse` checkpoint/waitingOn shapes from `@valet/api/wire` — read them first; `findPendingApproval` shows the waitingOn shape.)

- [ ] **Step 2: Implement `statusByNodeId(run, checkpoints)`** returning `Record<string, NodeRunStatus>`; foreach nodes: collapse iterations to one aggregate (any failed → failed; any incomplete → running; else succeeded) and include a `foreachProgress: Record<string, { done: number; total: number }>` second return if trivially derivable — badge text "k/n" on the node.

- [ ] **Step 3: Render `<WorkflowPreview definition={run.definition} statusByNodeId={...} height={320} />`** in `RunDetailBody` above the checkpoint list (run.definition is already in the response).

- [ ] **Step 4: Tests + typecheck + build; commit** — `git commit -m "Overlay per-node run status on the run detail canvas"`

### Task 6: Local k8s deliverable + smoke test

**Files:** none (ops)

- [ ] **Step 1: Full verification suite from repo root:** `pnpm typecheck` and `pnpm vitest run` in `packages/api`, `packages/web`, `packages/workflow`. Expected: PASS.
- [ ] **Step 2: Build images:** `make k8s-build` (confirm Docker/Rancher Desktop in moby mode; else follow the Makefile's nerdctl hint). Expected: `valet-api:dev` + `valet-sandbox:dev` built.
- [ ] **Step 3: Deploy:** `make k8s-sandbox-install` (if not already installed) then `make k8s-up`. Verify: `kubectl --context rancher-desktop -n valet get pods` → api + postgres Running; `make k8s-logs` shows `workflowRunHost` started.
- [ ] **Step 4: Manual smoke** in the browser (chart's ingress/port — check `make k8s-up` output / chart README): log in, open orchestrator chat, send the smoke prompt (below), verify: workflow card renders with DAG preview → open `/workflows` list → run starts → approval card appears in chat → approve → run settles → run detail canvas shows green path.
- [ ] **Step 5: Commit any fixes; hand the user the URL + smoke prompt.**

**Smoke-test prompt (deliverable):**

> Create a workflow called "Demo triage" with this shape: a trigger node, then a set node that sets `greeting` to "hello", then an approval node asking me to confirm before proceeding, then an llm node that writes a haiku about the greeting, then a stop node. Save it, show it to me, then start a run and tell me when it's waiting on my approval.

## Verification checklist (before claiming done)

- [ ] `workflows.*` tools appear in the agent's `list_tools` output on the k8s env
- [ ] Chat renders a DAG preview card for save/get/start/get_run tool calls (not the generic fallback)
- [ ] Approval actionable from chat only while run is parked on that gate
- [ ] `/workflows` list + editor + run detail unaffected regressions-wise
- [ ] All package typechecks, tests, and `packages/web` build pass
