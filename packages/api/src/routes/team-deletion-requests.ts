import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireActingUser } from "../middleware/auth.js";
import { ConfigManagedTeamError, IdpManagedTeamError } from "../services/teams.js";
import { decideDeletionRequest, isDeletionResourceType, listDeletionRequests, listDeletionTargets, submitDeletionRequest } from "../services/team-deletion-requests.js";

export const teamDeletionRequestsRouter = new Hono<AppEnv>();
teamDeletionRequestsRouter.use("/:id/deletion-requests/*", async (c, next) => {
  if (!requireActingUser(c)) return c.json({ error: "Sign in as a person to manage deletion requests." }, 403);
  await next();
});
teamDeletionRequestsRouter.get("/:id/deletion-requests/targets", async (c) => {
  return c.json({ targets: await listDeletionTargets(c.var.providers.db, { orgId: c.var.user.orgId, userId: c.var.user.id, teamId: c.req.param("id") }) });
});
teamDeletionRequestsRouter.get("/:id/deletion-requests", async (c) => {
  if (!requireActingUser(c)) return c.json({ error: "Sign in as a person to manage deletion requests." }, 403);
  return c.json({ requests: await listDeletionRequests(c.var.providers.db, { orgId: c.var.user.orgId, userId: c.var.user.id, teamId: c.req.param("id") }) });
});
teamDeletionRequestsRouter.post("/:id/deletion-requests", async (c) => {
  if (!requireActingUser(c)) return c.json({ error: "Sign in as a person to manage deletion requests." }, 403);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("resourceType" in body) || !isDeletionResourceType(body.resourceType) ||
      !("resourceId" in body) || typeof body.resourceId !== "string" || !body.resourceId.trim() || body.resourceId.length > 256 ||
      ("reason" in body && (typeof body.reason !== "string" || body.reason.length > 2000))) {
    return c.json({ error: "Choose a resource and provide a reason of at most 2000 characters." }, 400);
  }
  try {
    const result = await submitDeletionRequest(c.var.providers.db, { orgId: c.var.user.orgId, userId: c.var.user.id, teamId: c.req.param("id") },
      body.resourceType, body.resourceId, "reason" in body && typeof body.reason === "string" ? body.reason : undefined);
    return c.json(result, result.created ? 201 : 200);
  } catch (err) {
    if (err instanceof IdpManagedTeamError || err instanceof ConfigManagedTeamError) return c.json({ error: err.message, code: err.code }, 409);
    throw err;
  }
});
teamDeletionRequestsRouter.post("/:id/deletion-requests/:requestId/:decision", async (c) => {
  const decision = c.req.param("decision");
  if (decision !== "approve" && decision !== "decline" && decision !== "withdraw") return c.json({ error: "Choose approve, decline, or withdraw." }, 400);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || ("note" in body && (typeof body.note !== "string" || body.note.length > 2000))) {
    return c.json({ error: "Send a JSON object with an optional note of at most 2000 characters." }, 400);
  }
  const p = c.var.providers;
  const result = await decideDeletionRequest({ db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials },
    { orgId: c.var.user.orgId, userId: c.var.user.id, teamId: c.req.param("id") }, c.req.param("requestId"), decision,
    "note" in body && typeof body.note === "string" ? body.note : undefined);
  if (result.refusal) return c.json({ error: result.refusal }, 409);
  for (const id of result.sessions) await p.engineHost.destroy(id).catch((err) => console.error("Approved team deletion: session teardown failed", err));
  if (decision === "approve" && result.resourceType === "credential") await p.contentSync.resyncTeamWorkflowSources(c.req.param("id"));
  return c.json({ ok: true });
});
