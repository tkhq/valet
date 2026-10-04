/**
 * PUBLIC generic event-webhook ingress: POST /webhooks/events/:service.
 * Auth is signature-level per service (plugin TriggerDef.verify over raw
 * bytes) — mounted before the auth middleware in app.ts.
 */
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { TriggerRejection } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { credentials, linearInstallations } from "../schema/index.js";
import { LINEAR_CREDENTIAL_SERVICE } from "../services/linear-app.js";
import { isRecord } from "../lib/oauth-state.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { ingestEvent } from "../events/ingest.js";

/** Same rationale as `routes/github-app.ts`'s cap: bound what an
 * unauthenticated caller can force us to buffer/parse. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Linear counts only HTTP 200 as delivered and retries anything else. */
const ACK = (c: Context<AppEnv>) => c.body(null, 200);

export const eventWebhooksRouter = new Hono<AppEnv>();

eventWebhooksRouter.post("/:service", async (c) => {
  const service = c.req.param("service");
  const { db, plugins } = c.var.providers;

  const triggerDefs = plugins.flatMap((p) => p.triggers ?? []).filter((t) => t.service === service);
  if (triggerDefs.length === 0) return c.json({ error: "unknown service" }, 404);

  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }

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
    if (!organizationId) return ACK(c);
    const rows = await db
      .select()
      .from(linearInstallations)
      .where(eq(linearInstallations.workspaceId, organizationId))
      .limit(1);
    const install = rows[0];
    if (!install) return ACK(c); // unknown workspace: ack, don't retry-loop Linear
    orgId = install.orgId;
    // Read the signing secret from the row, not through engineCredentials: its
    // Linear layer may request a new app token, and an unsigned request must
    // not cause outbound work. The secret sits in plain metadata.
    const [cred] = await db.select({ metadata: credentials.metadata }).from(credentials)
      .where(and(eq(credentials.ownerType, "org"), eq(credentials.ownerId, orgId), eq(credentials.service, LINEAR_CREDENTIAL_SERVICE))).limit(1);
    const metadata = isRecord(cred?.metadata) ? cred.metadata : {};
    const webhookSecret = typeof metadata.webhookSecret === "string" ? metadata.webhookSecret : undefined;
    if (!webhookSecret) {
      await writeDropLog(db, { orgId, reason: "unknown_org", detail: `linear webhook for ${organizationId}: no credential` });
      return ACK(c);
    }
    secrets = { webhookSecret };
  } else {
    return c.json({ error: "unknown service" }, 404);
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  for (const def of triggerDefs) {
    const verified = await def.verify({ headers, rawBody }, secrets);
    if (verified) {
      await ingestEvent(
        { db, plugins, onIngest: c.var.providers.eventDispatcher.nudge },
        { orgId, service, event: def.toEvent(verified) },
      );
      return ACK(c);
    }
  }

  // A correctly signed delivery Valet does not handle is acknowledged:
  // Linear retries any other answer and can disable a webhook that keeps
  // failing, which would stop the events Valet does handle.
  const explainer = triggerDefs.find((def) => def.explainRejection);
  const rejection: TriggerRejection = await explainer?.explainRejection?.({ headers, rawBody }, secrets)
    ?? { reason: "bad_signature", detail: `service=${service}` };
  await writeDropLog(db, { orgId, reason: rejection.reason, detail: rejection.detail });
  if (rejection.reason !== "bad_signature") return ACK(c);
  return c.json({ error: "signature verification failed" }, 403);
});
