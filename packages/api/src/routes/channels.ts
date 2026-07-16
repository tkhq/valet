import { Hono } from "hono";
import type { AppEnv } from "../env.js";

/** PUBLIC ingress — mounted before the auth gate; verification is transport-level. */
export const channelsRouter = new Hono<AppEnv>();

/** Telegram/etc. updates are small JSON — media arrives by `file_id`
 * reference, not inline bytes. 1 MiB is generous headroom while capping the
 * unauthenticated body an attacker can force us to buffer/parse. */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

channelsRouter.post("/:channelType/webhook", async (c) => {
  const channelType = c.req.param("channelType");

  // Fast-path reject on the declared Content-Length before reading the
  // body at all.
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }

  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  // Defense when the header is absent or lying (chunked encoding, a
  // mismatched/forged Content-Length): re-check the actual bytes read
  // before ever calling the host.
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const result = await c.var.providers.channelHost.handleWebhook(channelType, { headers, rawBody });
  if (result === "unknown_channel") return c.json({ error: "unknown channel" }, 404);
  if (result === "rejected") return c.json({ error: "verification failed" }, 403);
  return c.json({ ok: true });
});
