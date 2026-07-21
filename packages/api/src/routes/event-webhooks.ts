/**
 * PUBLIC generic event-webhook ingress: POST /webhooks/events/:service.
 * Auth is signature-level per service (plugin TriggerDef.verify over raw
 * bytes) — mounted before the auth middleware in app.ts.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { VerifiedEvent } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { linearInstallations } from "../schema/index.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { ingestEvent } from "../events/ingest.js";

/** Same rationale as `routes/github-app.ts`'s cap: bound what an
 * unauthenticated caller can force us to buffer/parse. */
const MAX_BODY_BYTES = 1024 * 1024;

export const eventWebhooksRouter = new Hono<AppEnv>();

eventWebhooksRouter.post("/:service", async (c) => {
  const service = c.req.param("service");
  const { db, plugins, engineCredentials } = c.var.providers;

  const triggerDefs = plugins.flatMap((p) => p.triggers ?? []).filter((t) => t.service === service);
  if (triggerDefs.length === 0) return c.json({ error: "unknown service" }, 404);

  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

  // Per-service org + secret resolution. Only linear ships in this plan;
  // add a branch per future service that lands here.
  let orgId: string;
  let secrets: Record<string, string>;
  if (service === "linear") {
    let organizationId: string | undefined;
    try {
      const peek = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
      organizationId = typeof peek.organizationId === "string" ? peek.organizationId : undefined;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!organizationId) return c.body(null, 204);
    const rows = await db
      .select()
      .from(linearInstallations)
      .where(eq(linearInstallations.workspaceId, organizationId))
      .limit(1);
    const install = rows[0];
    if (!install) return c.body(null, 204); // unknown workspace: ack, don't retry-loop Linear
    orgId = install.orgId;
    const cred = await engineCredentials.get({ type: "org", id: orgId }, "linear");
    const webhookSecret = typeof cred?.metadata?.webhookSecret === "string" ? cred.metadata.webhookSecret : undefined;
    if (!webhookSecret) {
      await writeDropLog(db, { orgId, reason: "unknown_org", detail: `linear webhook for ${organizationId}: no credential` });
      return c.body(null, 204);
    }
    secrets = { webhookSecret };
  } else {
    return c.json({ error: "unknown service" }, 404);
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  let verified: VerifiedEvent | null = null;
  for (const def of triggerDefs) {
    verified = await def.verify({ headers, rawBody }, secrets);
    if (verified) {
      await ingestEvent(
        { db, plugins, onIngest: undefined /* Task 6 wires providers.eventDispatcher.nudge */ },
        { orgId, service, event: def.toEvent(verified) },
      );
      return c.body(null, 204);
    }
  }

  await writeDropLog(db, { orgId, reason: "bad_signature", detail: `service=${service}` });
  return c.json({ error: "signature verification failed" }, 403);
});
