/**
 * PUBLIC arbitrary-URL webhook ingress (overhaul design decision 5,
 * docs/specs/2026-07-16-workflows-overhaul-design.md):
 * `POST /api/hooks/workflows/:workflowId/:hookId`. Same reasoning as
 * `event-webhooks.ts`/`channelsRouter`/`githubAppWebhookRouter` — the
 * caller holds a bearer secret in the URL, not a logged-in Valet session,
 * so this router is mounted BEFORE `buildAuthMiddleware` in app.ts and
 * verification happens inside the handler (`webhook-service.ts`'s
 * constant-time compare), not the auth gate.
 *
 * The run starts owned by the WORKFLOW's own owner (from
 * `workflow_definitions`), never a caller-supplied identity — there is no
 * caller identity here to trust in the first place.
 */
import { Hono } from "hono";
import type { RunParams, WorkflowTriggerPayload } from "@valet/workflow";
import type { AppEnv } from "../env.js";
import { definitionVersionId } from "../workflows/definition-version.js";
import { deriveWebhookRunId, resolveWebhookTarget } from "../workflows/webhook-service.js";

/** Same rationale as `event-webhooks.ts`'s cap: bound what an
 * unauthenticated caller can force us to buffer/parse. Decision 5 sets
 * this at 64KB. */
const MAX_BODY_BYTES = 64 * 1024;

export const workflowHooksRouter = new Hono<AppEnv>();

workflowHooksRouter.post("/workflows/:workflowId/:hookId", async (c) => {
  const { db, workflowRunHost, webhookRateLimiter } = c.var.providers;
  const workflowId = c.req.param("workflowId");
  const hookId = c.req.param("hookId");

  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

  // Rate-limit BEFORE verifying the hookId: the limiter's job is to bound
  // secret-guessing against `workflowId` (public, from the URL path), not
  // just to throttle successful fires. Checking it after resolution would
  // let a guesser make unlimited attempts against every wrong hookId and
  // only start counting once they'd already won.
  if (!webhookRateLimiter.allow(workflowId, Date.now())) {
    return c.json({ error: "rate limited" }, 429);
  }

  const target = await resolveWebhookTarget(db, workflowId, hookId);
  if (!target) return c.json({ error: "not found" }, 404);

  let data: Record<string, unknown> = {};
  if (rawBody.byteLength > 0) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return c.json({ error: "body must be a JSON object" }, 400);
      }
      data = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
  }

  const runId = deriveWebhookRunId(workflowId, c.req.header("idempotency-key"));
  const trigger: WorkflowTriggerPayload = {
    type: "webhook",
    timestamp: new Date().toISOString(),
    data,
    metadata: {},
  };
  const params: RunParams = {
    workflowId,
    definitionVersionId: definitionVersionId(target.definition),
    input: trigger,
  };

  await workflowRunHost.start(runId, params, target.definition, {
    ownerType: target.ownerType,
    ownerId: target.ownerId,
  });

  return c.json({ runId }, 202);
});
