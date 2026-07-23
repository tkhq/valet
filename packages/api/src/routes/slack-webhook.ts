/**
 * PUBLIC Slack ingress: POST /api/channels/slack/webhook — mounted BEFORE
 * the generic `/api/channels/:channelType/webhook` route so the more
 * specific path wins. Slack delivers ALL app traffic (Events API JSON and
 * form-encoded interactivity) to one app-level URL; this route verifies the
 * signing-secret HMAC ONCE (via the transport, secrets from the org
 * credential's metadata — not the host's per-boot generated secret) and
 * fans each update out to both consumers:
 *
 * - channel: `transport.parseUpdate` → `channelHost.handleUpdate` (DMs,
 *   mentions → orchestrator prompts; block_actions → gate callbacks)
 * - events: Slack TriggerDefs → `ingestEvent` (subscriptions → workflows),
 *   where `ephemeral` catalog keys are match-gated
 *
 * Ack policy (Slack's 3s window): url_verification echoes immediately,
 * `x-slack-retry-num` redeliveries are dropped with 200 (durable
 * idempotency: engine dispatchId admission + events dedupeKey), and the
 * fan-out runs after the 200 is returned (fire-and-forget, errors logged).
 */
import { Hono } from "hono";
import type { TriggerDef, ValetPlugin } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { resolveOrgId } from "../lib/org.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { ingestEvent } from "../events/ingest.js";

const MAX_BODY_BYTES = 1024 * 1024;

/** Same rationale as ChannelHost.maybeLogVerifyFailed: this route is public
 * and unauthenticated, so a burst of bad/half-configured posts must not flood
 * `event_drop_log`. Throttle the write (not the response) per reason. */
const DROPLOG_COOLDOWN_MS = 60_000;
const droplogLoggedAt = new Map<string, number>();

/** Test-only: clears the per-process drop-log throttle so suites can assert
 * one row per reason without the 60s cooldown bleeding across cases. */
export function __resetSlackWebhookThrottle(): void {
  droplogLoggedAt.clear();
}

async function throttledDropLog(
  db: Parameters<typeof writeDropLog>[0],
  args: { orgId: string; reason: string; detail: string },
): Promise<void> {
  const now = Date.now();
  const last = droplogLoggedAt.get(args.reason);
  if (last !== undefined && now - last < DROPLOG_COOLDOWN_MS) return;
  droplogLoggedAt.set(args.reason, now);
  await writeDropLog(db, args);
}

function slackTriggerDefs(plugins: ValetPlugin[]): TriggerDef[] {
  return plugins.flatMap((p) => p.triggers ?? []).filter((t) => t.service === "slack");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** team_id lives on the Events API envelope; interactivity nests it at team.id. */
function teamIdOf(update: unknown): string | undefined {
  if (!isRecord(update)) return undefined;
  if (typeof update.team_id === "string") return update.team_id;
  if (isRecord(update.team) && typeof update.team.id === "string") return update.team.id;
  return undefined;
}

export const slackWebhookRouter = new Hono<AppEnv>();

slackWebhookRouter.post("/webhook", async (c) => {
  const { db, plugins, engineCredentials, channelHost, eventDispatcher } = c.var.providers;

  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  // url_verification precedes signature verification: it's Slack's endpoint
  // setup handshake and the legacy route answered it the same way.
  const bodyText = new TextDecoder().decode(rawBody);
  if (!bodyText.startsWith("payload=")) {
    try {
      const peek: unknown = JSON.parse(bodyText);
      if (isRecord(peek) && peek.type === "url_verification" && typeof peek.challenge === "string") {
        return c.json({ challenge: peek.challenge });
      }
    } catch {
      // fall through — the transport's verifyWebhook rejects unparseable bodies
    }
  }

  // Slack redelivers on slow acks; processing can exceed the 3s window, so
  // retries are dropped outright — durable dedup makes this safe.
  if (c.req.header("x-slack-retry-num") !== undefined) return c.body(null, 200);

  const orgId = await resolveOrgId(db);
  const cred = await engineCredentials.get({ type: "org", id: orgId }, "slack");
  const webhookSecret = typeof cred?.metadata?.webhookSecret === "string" ? cred.metadata.webhookSecret : undefined;
  const credTeamId = typeof cred?.metadata?.teamId === "string" ? cred.metadata.teamId : undefined;
  const transport = channelHost.transportFor("slack");
  if (!cred || !webhookSecret || !transport) {
    await throttledDropLog(db, { orgId, reason: "unknown_org", detail: "slack webhook: no credential/secret/transport" });
    return c.body(null, 200); // ack — never retry-loop Slack against a half-configured org
  }

  // verifyWebhook is defensively wrapped: a malformed signature header must
  // never surface as an unauthenticated 500 (or crash the fan-out) — treat any
  // throw as a rejection.
  let raws: ReturnType<typeof transport.verifyWebhook>;
  try {
    raws = transport.verifyWebhook({ headers, rawBody }, { webhookSecret });
  } catch {
    raws = null;
  }
  if (raws === null) {
    await throttledDropLog(db, { orgId, reason: "bad_signature", detail: "slack webhook signature verification failed" });
    return c.body(null, 401);
  }

  // Verified. Ack now; fan out after the response.
  void (async () => {
    try {
      const defs = slackTriggerDefs(plugins);
      for (const raw of raws) {
        const teamId = teamIdOf(raw);
        // When we know our workspace, require the update to name it. A shared
        // Slack app signing secret is valid across every workspace that
        // installs the app, so an absent team id is treated as a mismatch
        // (drop) rather than defaulting to our own org.
        if (credTeamId && teamId !== credTeamId) {
          await throttledDropLog(db, {
            orgId,
            reason: "unknown_org",
            detail: `slack webhook for foreign/absent team ${teamId ?? "(none)"}`,
          });
          continue;
        }
        // Channel consumer.
        const event = transport.parseUpdate(raw);
        if (event) await channelHost.handleUpdate("slack", event);
        // Event consumer — TriggerDefs re-verify over the same raw bytes
        // (cheap HMAC) so their extraction stays authoritative; each def
        // rejects event types outside its family.
        for (const def of defs) {
          const verified = await def.verify({ headers, rawBody }, { webhookSecret });
          if (!verified) continue;
          await ingestEvent(
            { db, plugins, onIngest: eventDispatcher.nudge },
            { orgId, service: "slack", event: def.toEvent(verified) },
          );
          break;
        }
      }
    } catch (err) {
      console.error("[slack-webhook] fan-out failed", err);
    }
  })();

  return c.body(null, 200);
});
