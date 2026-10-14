/**
 * `POST /api/sandbox/actions/:toolId/invoke`: a workflow step's script calls
 * an integration action the way the step's own `tool` nodes do.
 *
 * Auth is the sandbox-token rung of `middleware/auth.ts` (`x-valet-sandbox`,
 * prefix `/api/sandbox/`). Only a workflow step session qualifies: its run
 * names the owner (`workflowSessionOwner`), and the call runs as that run
 * (`workflowExecutionId`). So `appliesIn: "workflow"` policies, the run's
 * grants, and the owner's credentials apply exactly as for a `tool` node,
 * and every call writes its Action Log row. No credential reaches the
 * sandbox.
 *
 * A call that policy holds for a person's approval is refused, because a
 * script cannot wait for one. Valet's own services stay refused, as they are
 * for every agent caller.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { buildActionInvoker, externalServiceRefusal } from "../plugins/action-invoker.js";
import { actorUserIdFor, parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { workflowSessionOwner } from "../workflows/session-owner.js";
import type { ActionInvokeResponse } from "../wire/types.js";
import { invokerOpts, parseToolId } from "./actions.js";

export const sandboxActionsRouter = new Hono<AppEnv>();

sandboxActionsRouter.post("/actions/:toolId/invoke", async (c) => {
  const sandbox = c.var.sandbox;
  if (!sandbox) return c.json({ error: "Send the sandbox token in x-valet-sandbox." }, 401);
  const owner = await workflowSessionOwner(c.var.providers.db, sandbox.sessionId, sandbox.orgId);
  if (owner === undefined) {
    return c.json({ error: "Only a workflow step can call actions from its sandbox. Ask the agent to call the tool instead." }, 403);
  }
  if (owner === null) return c.json({ error: "This workflow run is no longer available." }, 404);

  const toolId = c.req.param("toolId");
  const refused = externalServiceRefusal(toolId.split(".")[0] ?? "");
  if (refused) return c.json({ error: refused }, 403);
  const parsed = parseToolId(c, toolId);
  if (!parsed) return c.json({ error: `Unknown tool "${toolId}". Use a service.action id from the integration's tool list.` }, 404);
  const body = await readOptionalJsonObject(c);
  const params = body?.params ?? {};
  if (!body || typeof params !== "object" || params === null || Array.isArray(params)) {
    return c.json({ error: "Send a JSON object with params, such as {\"params\": {}}." }, 400);
  }

  const { runId, nodeId } = parseWorkflowSessionId(sandbox.sessionId);
  const run = await c.var.providers.workflowStore.getRun(runId);
  const result = await buildActionInvoker(invokerOpts(c))(
    { service: parsed.service, action: parsed.action, params: Object.fromEntries(Object.entries(params)), invocationId: `wf:${runId}:${nodeId}:script:${randomUUID()}` },
    { userId: run?.actorUserId ?? actorUserIdFor(owner), orgId: sandbox.orgId, owner, workflowExecutionId: runId },
  );
  if (result.ok) return c.json({ tool_id: toolId, status: "completed", result: result.result } satisfies ActionInvokeResponse);
  if ("requiresApproval" in result) {
    return c.json({
      tool_id: toolId, status: "approval_required",
      next_step: "Policy requires a person to approve this action, and a script cannot wait for approval. Call it from a tool node, or ask an admin to allow it for this workflow.",
    } satisfies ActionInvokeResponse, 403);
  }
  return c.json({ tool_id: toolId, status: "failed", error: result.error } satisfies ActionInvokeResponse);
});
