import { Hono } from "hono";
import type { AppEnv } from "../env.js";

/** PUBLIC ingress — mounted before the auth gate; verification is transport-level. */
export const channelsRouter = new Hono<AppEnv>();

channelsRouter.post("/:channelType/webhook", async (c) => {
  const channelType = c.req.param("channelType");
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const result = await c.var.providers.channelHost.handleWebhook(channelType, { headers, rawBody });
  if (result === "unknown_channel") return c.json({ error: "unknown channel" }, 404);
  if (result === "rejected") return c.json({ error: "verification failed" }, 403);
  return c.json({ ok: true });
});
