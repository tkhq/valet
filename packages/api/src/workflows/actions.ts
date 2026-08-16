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
  cancelWorkflowRun,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  isRunStatus,
  listRunsForOwner,
  listWorkflowDefinitions,
  resolveWorkflowApproval,
  RUN_STATUS_VALUES,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  type WorkflowOwner,
  type WorkflowServiceDeps,
} from "./service.js";
import { buildValidateEnvironment } from "./validation-env.js";
import { applyWorkflowPatch, type WorkflowEdgeRef } from "./patch.js";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listEventTypes,
  listWorkflowTriggers,
} from "./trigger-service.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
} from "./schedule-service.js";
import {
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  mintOrRotateWorkflowWebhook,
  workflowWebhookUrl,
} from "./webhook-service.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { WorkflowCursorError, type WorkflowDefinition, type WorkflowEdge } from "@valet/workflow";

/** Cap + bullet the validator's lint output for the LLM. The validator can
 * emit dozens of errors on a badly-shaped definition; the first ~20 are
 * plenty to act on and keep the tool result readable. */
export function formatLintErrors(errors: string[], cap = 20): string {
  const shown = errors.slice(0, cap).map((e) => `- ${e}`);
  const more = errors.length > cap ? `\n… and ${errors.length - cap} more` : "";
  return `workflow definition failed validation (fix these and retry):\n${shown.join("\n")}${more}`;
}

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

      // The validate env is best-effort: if deps aren't wired (early boot,
      // or a test that only exercises validation), lint without the
      // catalog hooks rather than failing the whole call.
      let catalog: WorkflowServiceDeps["actionPluginByService"];
      try {
        catalog = getDeps().actionPluginByService;
      } catch {
        catalog = undefined;
      }
      const validation = validateDefinitionInput(definition, buildValidateEnvironment(catalog));
      if (!validation.ok) {
        return {
          success: false,
          error: formatLintErrors(validation.errors),
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
      if ("invalidInput" in started) {
        return {
          success: false,
          error:
            `run input is invalid: ${started.invalidInput.map((e) => e.message).join(" ")} ` +
            "Fix the listed inputs and start the run again.",
        };
      }
      return {
        success: true,
        data: { runId: started.runId, workflowId: workflow_id, status: "pending" },
      };
    },
  });

  const deleteWorkflow = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.delete_workflow",
    name: "Delete workflow",
    description:
      "Permanently delete a workflow definition. Refused (with an error) while the workflow " +
      "has non-settled runs — cancel them first. Settled run history is kept.",
    riskLevel: "medium",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowDefinition(getDeps(), owner, workflow_id);
      if (result === "not_found") {
        return { success: false, error: `workflow not found: ${workflow_id}` };
      }
      if (result === "has_active_runs") {
        return {
          success: false,
          error: `workflow ${workflow_id} has runs that are not settled — cancel them first, then delete`,
        };
      }
      return { success: true, data: { workflowId: workflow_id, deleted: true } };
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
            // The session a session node drove, and the run a workflow node
            // started — how the agent reaches a failed node's actual output.
            sessionId: cp.sessionId,
            childRunId: cp.childRunId,
          })),
        },
      };
    },
  });

  const listRuns = action(
    Type.Object({
      workflow_id: Type.Optional(Type.String()),
      parent_run_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number()),
      cursor: Type.Optional(Type.String()),
    }),
  )({
    id: "workflows.list_runs",
    name: "List workflow runs",
    description:
      "List runs (runId, status, outcome, timestamps), newest first. Omit workflow_id " +
      "for every workflow you can reach. Pass parent_run_id to track one batch's child " +
      "runs. Parked runs also carry waitingOn — the node and signal/timer each is blocked " +
      "on (signalType approval:<nodeId> = an approval node OR a policy gate on a tool " +
      "node). Use to find parked/pending runs before cancelling or checking approvals. " +
      "Paginated: pass the returned nextCursor back as cursor for the next page.",
    riskLevel: "low",
    execute: async ({ workflow_id, parent_run_id, status, limit, cursor }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const badStatus = status?.filter((s) => !isRunStatus(s));
      if (badStatus && badStatus.length > 0) {
        return {
          success: false,
          error: `unknown run status ${badStatus.join(", ")} — use one of: ${RUN_STATUS_VALUES.join(", ")}`,
        };
      }
      let page;
      try {
        page = await listRunsForOwner(getDeps(), owner, {
          workflowIds: workflow_id === undefined ? undefined : [workflow_id],
          status: status?.filter(isRunStatus),
          parentRunId: parent_run_id,
          limit,
          cursor,
        });
      } catch (err) {
        if (err instanceof WorkflowCursorError) return { success: false, error: err.message };
        throw err;
      }
      if (!page) return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: workflow_id, ...page } };
    },
  });

  const cancelRun = action(Type.Object({ run_id: Type.String() }))({
    id: "workflows.cancel_run",
    name: "Cancel workflow run",
    description:
      "Terminate a run (running, parked on a wait, or pending approval). Settling is " +
      "asynchronous — re-check with get_run after a few seconds if a follow-up (e.g. " +
      "delete_workflow) reports active runs.",
    riskLevel: "medium",
    execute: async ({ run_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // Self-invocation guard: a workflow session must not cancel runs.
      const sessionId = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith("wf:invoke:")) {
        return { success: false, error: "A workflow cannot cancel runs. Request cancellation through the web UI or API." };
      }
      const result = await cancelWorkflowRun(getDeps(), owner, run_id);
      if (result === "not_found") return { success: false, error: `run not found: ${run_id}` };
      return { success: true, data: { runId: run_id, cancelled: true } };
    },
  });

  const resolveApproval = action(
    Type.Object({
      run_id: Type.String(),
      node_id: Type.String(),
      approved: Type.Boolean(),
      note: Type.Optional(Type.String()),
      iteration: Type.Optional(Type.Number()),
    }),
  )({
    id: "workflows.resolve_approval",
    name: "Resolve workflow approval",
    description:
      "Approve or deny a run's pending approval-node gate. Approval gates exist for HUMANS — " +
      "only call this when the user has explicitly told you their decision in this " +
      "conversation; never resolve a gate on your own judgment. (This action itself " +
      "requires the user's confirmation.) Policy gates on tool nodes must be resolved " +
      "from the run page, not via this action.",
    riskLevel: "high",
    execute: async ({ run_id, node_id, approved, note, iteration }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // Self-invocation guard: a workflow session must not resolve approval gates.
      const sessionId = (ctx as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith("wf:invoke:")) {
        return { success: false, error: "A workflow cannot resolve approval gates. A human must resolve this gate from the run page." };
      }
      const result = await resolveWorkflowApproval(getDeps(), owner, {
        runId: run_id,
        nodeId: node_id,
        approved,
        note,
        iteration,
        via: "agent",
      });
      if (result === "not_found") return { success: false, error: `run not found: ${run_id}` };
      if (result === "not_parked") return { success: false, error: `run ${run_id} is not parked on approval gate ${node_id}` };
      if (result === "already_resolved") return { success: false, error: `approval gate ${node_id} on run ${run_id} has already been resolved` };
      if (result === "timed_out") return { success: false, error: `approval gate ${node_id} on run ${run_id} has timed out` };
      if (result === "human_only") return { success: false, error: "A human must resolve this policy gate from the run page." };
      if (result === "forbidden_always") return { success: false, error: "scope=always requires an org admin" };
      if (result === "org_mismatch") return { success: false, error: "not a member of this workflow's org" };
      return { success: true, data: { runId: run_id, nodeId: node_id, approved } };
    },
  });

  const patchWorkflow = action(
    Type.Object({
      workflow_id: Type.String(),
      name: Type.Optional(Type.String()),
      upsert_nodes: Type.Optional(Type.Array(Type.Unknown())),
      remove_node_ids: Type.Optional(Type.Array(Type.String())),
      add_edges: Type.Optional(
        Type.Array(
          Type.Object({
            from: Type.String(),
            to: Type.String(),
            fromOutput: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
            when: Type.Optional(Type.String()),
          }),
        ),
      ),
      remove_edges: Type.Optional(
        Type.Array(
          Type.Object({
            from: Type.String(),
            to: Type.String(),
            fromOutput: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
          }),
        ),
      ),
    }),
  )({
    id: "workflows.patch_workflow",
    name: "Patch workflow",
    description:
      "Edit a workflow WITHOUT re-sending the whole definition: rename, upsert single nodes " +
      "(replace-by-id or append), remove nodes (their edges go too), add/remove edges. " +
      "Prefer this over save_workflow for small edits — the patched result runs the full " +
      "linter, so a bad patch returns lint errors instead of saving.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, upsert_nodes, remove_node_ids, add_edges, remove_edges }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const wf = await getWorkflowDefinition(deps, owner, workflow_id);
      if (!wf) return { success: false, error: `workflow not found: ${workflow_id}` };

      const stored = wf.definition;
      if (
        typeof stored !== "object" ||
        stored === null ||
        !Array.isArray((stored as { nodes?: unknown }).nodes) ||
        !Array.isArray((stored as { edges?: unknown }).edges)
      ) {
        return { success: false, error: "stored definition is not a dag/v1 workflow" };
      }

      const patched = applyWorkflowPatch(stored as WorkflowDefinition, {
        upsertNodes: upsert_nodes,
        removeNodeIds: remove_node_ids,
        addEdges: add_edges as WorkflowEdge[] | undefined,
        removeEdges: remove_edges as WorkflowEdgeRef[] | undefined,
      });
      if (!patched.ok) return { success: false, error: formatLintErrors(patched.errors) };

      const validation = validateDefinitionInput(
        patched.definition,
        buildValidateEnvironment(deps.actionPluginByService),
      );
      if (!validation.ok) return { success: false, error: formatLintErrors(validation.errors) };

      const updated = await updateWorkflowDefinition(deps, owner, workflow_id, {
        name,
        definition: patched.definition,
      });
      if (!updated) return { success: false, error: `workflow not found: ${workflow_id}` };
      return {
        success: true,
        data: {
          workflowId: updated.id,
          name: updated.name,
          nodes: patched.definition.nodes.length,
          edges: patched.definition.edges.length,
        },
      };
    },
  });

  const getNodeResult = action(
    Type.Object({
      run_id: Type.String(),
      node_id: Type.String(),
      iteration: Type.Optional(Type.Number()),
    }),
  )({
    id: "workflows.get_node_result",
    name: "Get node result",
    description:
      "Fetch a run node's FULL checkpoint output (result + error) — use when debugging a " +
      "failed or surprising node; get_run intentionally omits result bodies. `result` is " +
      "the checkpoint value verbatim (the same value templates read via nodes.<id>.result); " +
      "an oversized result comes back as { truncated: true, jsonPrefix }. Foreach body " +
      "nodes have one checkpoint per iteration; pass `iteration` to narrow.",
    riskLevel: "low",
    execute: async ({ run_id, node_id, iteration }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const detail = await getWorkflowRunDetail(getDeps(), owner, run_id);
      if (!detail) return { success: false, error: `run not found: ${run_id}` };
      const matches = detail.checkpoints.filter(
        (cp) => cp.nodeId === node_id && (iteration === undefined || cp.iteration === iteration),
      );
      if (matches.length === 0) {
        const known = [...new Set(detail.checkpoints.map((cp) => cp.nodeId))];
        return {
          success: false,
          error: `run ${run_id} has no checkpoint for node ${JSON.stringify(node_id)} (nodes with checkpoints: ${known.join(", ") || "none"})`,
        };
      }
      return {
        success: true,
        data: {
          runId: run_id,
          nodeId: node_id,
          checkpoints: matches.map((cp) => ({
            iteration: cp.iteration,
            status: cp.status,
            error: cp.error,
            result: presentResult(cp.result, 20_000),
          })),
        },
      };
    },
  });

  const listEventTypesAction = action(Type.Object({}))({
    id: "workflows.list_event_types",
    name: "List event types",
    description:
      "List the event keys workflows can be triggered by (per service, with filterable " +
      "fields). Use before create_trigger to pick a valid event key.",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const services = listEventTypes(getDeps().plugins ?? []);
      if (services.length === 0) {
        return {
          success: true,
          data: { services, note: "no event-emitting integrations are connected yet" },
        };
      }
      return { success: true, data: { services } };
    },
  });

  const createTrigger = action(
    Type.Object({
      workflow_id: Type.String(),
      name: Type.String(),
      event_keys: Type.Array(Type.String(), {
        description: 'Event key patterns; trailing ".*" wildcard supported (e.g. "github.pull_request.*").',
      }),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal("eq"),
              Type.Literal("in"),
              Type.Literal("prefix"),
              Type.Literal("contains"),
            ]),
            value: Type.Unknown(),
          }),
        ),
      ),
    }),
  )({
    id: "workflows.create_trigger",
    name: "Create workflow trigger",
    description:
      "Make a workflow run automatically on matching events (event-driven only — cron " +
      "schedules are not supported yet). The event arrives in templates as " +
      "{{trigger.data.payload...}} plus {{trigger.data.key}}/{{trigger.data.refs...}}. " +
      "Returns { triggerId }.",
    riskLevel: "medium",
    execute: async ({ workflow_id, name, event_keys, filters }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const deps = getDeps();
      const result = await createWorkflowTrigger(
        deps.db,
        deps.plugins ?? [],
        { id: owner.userId, orgId: owner.orgId },
        { workflowId: workflow_id, name, eventKeys: event_keys, filters },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.trigger };
    },
  });

  const listTriggers = action(
    Type.Object({ workflow_id: Type.Optional(Type.String()) }),
  )({
    id: "workflows.list_triggers",
    name: "List workflow triggers",
    description: "List event triggers targeting workflows (optionally one workflow's).",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const triggers = await listWorkflowTriggers(getDeps().db, owner.orgId, workflow_id);
      return { success: true, data: { triggers } };
    },
  });

  const createSchedule = action(
    Type.Object({
      workflow_id: Type.Optional(
        Type.String({ description: "Target a workflow: start a run each fire." }),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "Target the orchestrator instead: this prompt is delivered to you (the " +
            "orchestrator) each fire, on a dedicated thread. Provide exactly one of " +
            "workflow_id or prompt.",
        }),
      ),
      name: Type.String(),
      cron: Type.String({
        description: '5-field cron expression, e.g. "0 9 * * 1-5" = 9:00 every weekday.',
      }),
      timezone: Type.Optional(
        Type.String({ description: 'IANA timezone name (default "UTC"), e.g. "America/Denver".' }),
      ),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Workflow target only: static payload delivered as {{trigger.data.input...}}.",
        }),
      ),
    }),
  )({
    id: "workflows.create_schedule",
    name: "Create schedule",
    description:
      "Run something on a cron schedule: a WORKFLOW (workflow_id → a run starts each fire) " +
      "or the ORCHESTRATOR (prompt → you receive the prompt each fire, e.g. 'check my PRs " +
      "every morning'). Fires are accurate to ~30s; missed fires during downtime collapse " +
      "into one catch-up. Returns { scheduleId, nextFireAt }.",
    riskLevel: "medium",
    execute: async ({ workflow_id, prompt, name, cron, timezone, input }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await createWorkflowSchedule(
        getDeps().db,
        { id: owner.userId, orgId: owner.orgId },
        { workflowId: workflow_id, prompt, name, cron, timezone, input },
      );
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: result.schedule };
    },
  });

  const listSchedules = action(
    Type.Object({ workflow_id: Type.Optional(Type.String()) }),
  )({
    id: "workflows.list_schedules",
    name: "List workflow schedules",
    description: "List cron schedules (optionally one workflow's) with next/last fire times.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const schedules = await listWorkflowSchedules(getDeps().db, owner.orgId, workflow_id);
      return { success: true, data: { schedules } };
    },
  });

  const deleteSchedule = action(Type.Object({ schedule_id: Type.String() }))({
    id: "workflows.delete_schedule",
    name: "Delete workflow schedule",
    description: "Delete a cron schedule by id (from list_schedules/create_schedule).",
    riskLevel: "medium",
    execute: async ({ schedule_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowSchedule(getDeps().db, owner.orgId, schedule_id);
      if (result === "not_found") return { success: false, error: `schedule not found: ${schedule_id}` };
      return { success: true, data: { scheduleId: schedule_id, deleted: true } };
    },
  });

  const deleteTrigger = action(Type.Object({ trigger_id: Type.String() }))({
    id: "workflows.delete_trigger",
    name: "Delete workflow trigger",
    description: "Delete a workflow trigger by id (from list_triggers/create_trigger).",
    riskLevel: "medium",
    execute: async ({ trigger_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowTrigger(getDeps().db, owner.orgId, trigger_id);
      if (result === "not_found") return { success: false, error: `trigger not found: ${trigger_id}` };
      return { success: true, data: { triggerId: trigger_id, deleted: true } };
    },
  });

  const createWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.create_webhook",
    name: "Create or rotate workflow webhook",
    description:
      "Mint an arbitrary-URL trigger for a workflow: POST any JSON to the returned URL and a run " +
      "starts, no Valet auth required — the URL itself is the credential. Calling this again on the " +
      "same workflow ROTATES the secret: the old URL stops working immediately. Returns { workflowId, " +
      "hookId, url }.",
    // high, not medium: this mints a bearer secret that is the ENTIRE auth
    // for triggering a run — equivalent in blast radius to granting a new
    // credential, which the plugin catalog's default policy (medium ==
    // auto-allow) would otherwise let the agent do with no human in the
    // loop, the same reasoning that keeps resolve_approval at "high".
    riskLevel: "high",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await mintOrRotateWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (!result.ok) return { success: false, error: result.error };
      return {
        success: true,
        data: { ...result.webhook, url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId) },
      };
    },
  });

  const getWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.get_webhook",
    name: "Get workflow webhook",
    description: "Look up the current webhook URL for a workflow, or null if none has been minted.",
    riskLevel: "low",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await getWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (!result.ok) return { success: false, error: result.error };
      if (!result.webhook) return { success: true, data: { webhook: null } };
      return {
        success: true,
        data: { webhook: { ...result.webhook, url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId) } },
      };
    },
  });

  const deleteWebhook = action(Type.Object({ workflow_id: Type.String() }))({
    id: "workflows.delete_webhook",
    name: "Delete workflow webhook",
    description: "Remove a workflow's webhook trigger, if any. The URL 404s afterward.",
    riskLevel: "medium",
    execute: async ({ workflow_id }, ctx) => {
      const owner = ownerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const result = await deleteWorkflowWebhook(getDeps().db, owner, workflow_id);
      if (result === "not_found") return { success: false, error: `workflow not found: ${workflow_id}` };
      return { success: true, data: { workflowId: workflow_id, deleted: result === "deleted" } };
    },
  });

  return {
    service: "workflows",
    description:
      "Create, inspect, and run Valet DAG workflows (dag/v1 definitions: nodes + edges).",
    actions: [
      listWorkflows,
      getWorkflow,
      saveWorkflow,
      patchWorkflow,
      deleteWorkflow,
      startRun,
      getRun,
      getNodeResult,
      listRuns,
      cancelRun,
      resolveApproval,
      listEventTypesAction,
      createTrigger,
      listTriggers,
      deleteTrigger,
      createSchedule,
      listSchedules,
      deleteSchedule,
      createWebhook,
      getWebhook,
      deleteWebhook,
    ],
  };
}

/**
 * Return a checkpoint result verbatim when its JSON fits `maxChars`, so the
 * agent sees the same structured value templates read via
 * `nodes.<id>.result`. An oversized result becomes a `{ truncated: true,
 * jsonPrefix }` stub so a giant payload can't blow up the LLM context.
 * (An earlier always-stringified wrapper here read as the checkpoint's own
 * shape and convinced agents the data was unreachable.)
 */
function presentResult(value: unknown, maxChars: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch (err) {
    json = `<unserializable: ${err instanceof Error ? err.message : String(err)}>`;
    return { truncated: true, jsonPrefix: json };
  }
  if (json.length <= maxChars) return value;
  return { truncated: true, jsonPrefix: json.slice(0, maxChars) };
}
