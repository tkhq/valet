/**
 * Agent-facing workflow actions (spec:
 * docs/specs/2026-07-31-workflow-chat-rendering-design.md). Exposed through
 * the plugin catalog (`list_tools`/`call_tool`) so the orchestrator can
 * create, inspect, and run dag/v1 workflows conversationally. Every result
 * carries the ids (`workflowId`/`runId`) the web chat renderer fetches by.
 */
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import {
  createWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  listWorkflowDefinitions,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  type WorkflowOwner,
  type WorkflowServiceDeps,
} from "./service.js";

export function ownerFromContext(ctx: PluginActionContext): WorkflowOwner | null {
  const { userId, orgId } = ctx as { userId?: unknown; orgId?: unknown };
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  return { userId, orgId };
}

const NO_OWNER: PluginActionResult = {
  success: false,
  error: "no authenticated principal in tool context",
};

/**
 * Curried action builder (same shape as plugin-github's): the first call
 * binds T from the parameters schema; the second types `execute`'s args via
 * Static<T>, sidestepping TS's contextual-inference depth limit.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

/**
 * `getDeps` is a getter (not the deps object) because the plugin list is
 * assembled before the workflow store / run host exist at boot — same
 * one-slot-indirection pattern `providers/node.ts` uses for `childSpawner`.
 * It throws until provider wiring completes; actions only execute long
 * after boot, so callers never observe the window.
 */
export function workflowsActionPlugin(getDeps: () => WorkflowServiceDeps): ActionPlugin {
  const listWorkflows = action(Type.Object({}))({
    id: "workflows.list_workflows",
    name: "List workflows",
    description: "List the user's workflow definitions (id, name, timestamps).",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const workflows = await listWorkflowDefinitions(getDeps(), owner);
      return {
        success: true,
        data: {
          workflows: workflows.map((w) => ({
            workflowId: w.id,
            name: w.name,
            updatedAt: w.updatedAt,
          })),
        },
      };
    },
  });

  const getWorkflow = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.get_workflow",
    name: "Get workflow",
    description: "Fetch one workflow definition (full dag/v1 nodes + edges) by id.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const wf = await getWorkflowDefinition(getDeps(), owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };
      return {
        success: true,
        data: {
          workflowId: wf.id,
          name: wf.name,
          definition: wf.definition,
          updatedAt: wf.updatedAt,
        },
      };
    },
  });

  const saveWorkflow = action(
    Type.Object({
      workflow_id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      definition: Type.Unknown(),
    }),
  )({
    id: "workflows.save_workflow",
    name: "Save workflow",
    description:
      "Create a workflow (omit workflow_id) or update one (pass workflow_id). " +
      "`definition` MUST be a dag/v1 object: { version: 'dag/v1', nodes: [...], edges: [...] } " +
      "using node types trigger|set|if|wait|approval|session|orchestrator|tool|llm|stop|foreach. " +
      "The definition is validated before saving; validation errors come back in `error`. " +
      "Returns { workflowId } — always surface it to the user.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, definition }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;

      const validation = validateDefinitionInput(definition);
      if (!validation.ok) {
        return {
          success: false,
          error: `invalid workflow definition: ${validation.errors.join("; ")}`,
        };
      }

      if (workflow_id) {
        const updated = await updateWorkflowDefinition(getDeps(), owner, workflow_id, {
          name,
          definition,
        });
        if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
        return {
          success: true,
          data: { workflowId: updated.id, name: updated.name, updatedAt: updated.updatedAt },
        };
      }

      const created = await createWorkflowDefinition(getDeps(), owner, {
        name: name ?? "Untitled workflow",
        definition,
      });
      return {
        success: true,
        data: { workflowId: created.id, name: created.name, updatedAt: created.updatedAt },
      };
    },
  });

  const startRun = action(
    Type.Object({
      workflow_id: Type.String(),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  )({
    id: "workflows.start_run",
    name: "Start workflow run",
    description:
      "Start a run of a workflow. Optional `input` becomes the trigger payload data. " +
      "Returns { runId, workflowId } — always surface the runId to the user.",
    riskLevel: "medium",
    execute: async ({ workflow_id, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const started = await startWorkflowRun(getDeps(), owner, workflow_id, input);
      if (!started) return { success: false, error: `workflow not found: ${workflow_id}` };
      return {
        success: true,
        data: { runId: started.runId, workflowId: workflow_id, status: "pending" },
      };
    },
  });

  const getRun = action(Type.Object({ run_id: Type.String() }))({
    id: "workflows.get_run",
    name: "Get workflow run",
    description:
      "Fetch a run's status, outcome, per-node checkpoints, and what it is waiting on " +
      "(timers, signals, approvals). Use to check progress or find pending approval gates.",
    riskLevel: "low",
    execute: async ({ run_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const detail = await getWorkflowRunDetail(getDeps(), owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      return {
        success: true,
        data: {
          runId: detail.run.runId,
          workflowId: detail.run.workflowId,
          status: detail.run.status,
          outcome: detail.run.outcome,
          waitingOn: detail.run.waitingOn,
          checkpoints: detail.checkpoints.map((cp) => ({
            nodeId: cp.nodeId,
            iteration: cp.iteration,
            status: cp.status,
            error: cp.error,
          })),
        },
      };
    },
  });

  return {
    service: "workflows",
    description:
      "Create, inspect, and run Valet DAG workflows (dag/v1 definitions: nodes + edges).",
    actions: [listWorkflows, getWorkflow, saveWorkflow, startRun, getRun],
  };
}
