/**
 * `POST /api/sandbox/actions/:toolId/invoke`: a workflow step's script calls
 * an integration action with the same power as the step's agent.
 *
 * Auth is the sandbox-token rung of `middleware/auth.ts` (`x-valet-sandbox`,
 * prefix `/api/sandbox/`). Only a workflow step session of an active run
 * qualifies: its run names the owner (`workflowSessionOwner`), and a settled
 * or cancelled run's script can call nothing more. The call runs through the
 * action invoker in the tool broker's external mode, so `appliesIn:
 * "session"` policies apply exactly as they do to the step's agent, and no
 * workflow grant meant for `tool` nodes applies. Code in the sandbox can
 * therefore do nothing the agent cannot. The owner's credentials make the
 * call, each call writes its Action Log row, and no credential reaches the
 * sandbox.
 *
 * A call that policy holds for approval is refused, because a script cannot
 * wait for one. Valet's own services stay refused, as for every agent
 * caller. `idempotencyKey` makes a retry return the first call's result.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { actionInvocations } from "../schema/index.js";
import { buildActionInvoker, externalServiceRefusal } from "../plugins/action-invoker.js";
import { actorUserIdFor, parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { workflowSessionOwner } from "../workflows/session-owner.js";
import type { ActionInvokeResponse } from "../wire/types.js";
import { approvalRequired, invokerOpts, paramsDigest, parseToolId } from "./actions.js";

export const sandboxActionsRouter = new Hono<AppEnv>();

const MAX_IDEMPOTENCY_KEY = 200;

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

  const key = body.idempotencyKey;
  if (key !== undefined && (typeof key !== "string" || key === "" || key.length > MAX_IDEMPOTENCY_KEY)) {
    return c.json({ error: `Set idempotencyKey to a string of 1-${MAX_IDEMPOTENCY_KEY} characters, or omit it.` }, 400);
  }

  const { runId, nodeId } = parseWorkflowSessionId(sandbox.sessionId);
  const run = await c.var.providers.workflowStore.getRun(runId);
  if (!run || (run.status !== "running" && run.status !== "parked")) {
    return c.json({ error: "This workflow run has finished, so its steps can call no more actions." }, 409);
  }
  // A key is namespaced by run, step, tool, and params, as the broker does.
  const invocationId = `wf:${runId}:${nodeId}:script:${typeof key === "string" ? `${toolId}:${paramsDigest(params)}:${key}` : randomUUID()}`;
  const result = await buildActionInvoker(invokerOpts(c))(
    {
      service: parsed.service, action: parsed.action, params: Object.fromEntries(Object.entries(params)),
      invocationId,
    },
    {
      userId: run.actorUserId ?? actorUserIdFor(owner), orgId: sandbox.orgId, owner,
      external: { client: "workflow-script", attempt: randomUUID() },
    },
  );
  // A failure must not stick to the key: the script fixes the cause and retries.
  if (!result.ok && !("requiresApproval" in result)) {
    await c.var.providers.db.delete(actionInvocations).where(eq(actionInvocations.invocationId, invocationId));
  }
  if (result.ok) return c.json({ tool_id: toolId, status: "completed", result: result.result } satisfies ActionInvokeResponse);
  if ("requiresApproval" in result) return c.json(approvalRequired(toolId, result), 403);
  return c.json({ tool_id: toolId, status: "failed", error: result.error } satisfies ActionInvokeResponse);
});
