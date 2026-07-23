/**
 * `/api/me/identity-links` — per-user channel account linking, one block per
 * transport-declaring plugin. Link strategies are provider-shaped:
 *
 * - telegram: `POST /telegram/start` mints a code and returns a `t.me` deep
 *   link; the inbound `/start <code>` command consumes it.
 * - slack: `GET /slack/users?q=` typeahead → `POST /slack/start
 *   { externalId }` mints a code and the bot DMs it to that workspace member
 *   → `POST /slack/verify { code }` proves control and links. The code
 *   travels OUT to the account being linked, so verification happens here,
 *   not inbound.
 *
 * `PATCH /:provider` and `DELETE /:provider` are generic.
 *
 * Mounted BEFORE `/api/me` in `app.ts` so the longer, more specific prefix
 * wins under Hono's route matching.
 */
import { Hono } from "hono";
import type { ChannelTransport } from "@valet/engine";
import type { AppEnv } from "../env.js";
import {
  consumeLinkCode,
  identityForUser,
  linkIdentity,
  mintLinkCode,
  setNotifyAttention,
  unlinkIdentity,
} from "../channels/identity-links.js";
import type {
  DeleteIdentityLinkResponse,
  IdentityLinkStatus,
  ListIdentityLinksResponse,
  ListSlackWorkspaceMembersResponse,
  PatchIdentityLinkRequest,
  PatchIdentityLinkResponse,
  StartIdentityLinkResponse,
  StartSlackIdentityLinkRequest,
  VerifyIdentityLinkRequest,
  VerifyIdentityLinkResponse,
} from "../wire/types.js";

export const identityLinksRouter = new Hono<AppEnv>();

const START_LINK_TTL_SECONDS = 600;

/** Per-caller cooldown for the Slack link-start DM: the endpoint makes the
 * bot DM an arbitrary workspace member a code, so an authenticated member
 * must not be able to spam DMs from the trusted first-party bot. In-memory
 * (per api process) is sufficient — it bounds the abuse rate, not a security
 * boundary. */
const SLACK_START_COOLDOWN_MS = 30_000;
const slackStartAt = new Map<string, number>();

/** Test-only: clears the per-process Slack link-start cooldown. */
export function __resetSlackStartCooldown(): void {
  slackStartAt.clear();
}

/** Slack-shaped transport extras (feature-detected, same pattern as the host's getMe probe). */
function hasSlackLinkExtras(transport: ChannelTransport): transport is ChannelTransport & {
  openDirectConversation(externalId: string): Promise<string>;
  listWorkspaceMembers(query: string): Promise<Array<{ id: string; name: string; realName?: string }>>;
} {
  const t = transport as { openDirectConversation?: unknown; listWorkspaceMembers?: unknown };
  return typeof t.openDirectConversation === "function" && typeof t.listWorkspaceMembers === "function";
}

identityLinksRouter.get("/", async (c) => {
  const { db, channelHost, plugins } = c.var.providers;
  const user = c.var.user;

  const providerNames = plugins.flatMap((p) => p.transports ?? []).map((f) => f.channelType);
  const links: IdentityLinkStatus[] = [];
  for (const provider of providerNames) {
    const identity = await identityForUser(db, provider, user.id);
    links.push(
      identity
        ? {
            provider,
            linked: true,
            externalId: identity.externalId,
            notifyAttention: identity.notifyAttention,
            createdAt: identity.createdAt,
            channelReady: channelHost.isRunning(provider),
          }
        : { provider, linked: false, channelReady: channelHost.isRunning(provider) },
    );
  }

  const resp: ListIdentityLinksResponse = { links };
  return c.json(resp);
});

identityLinksRouter.post("/telegram/start", async (c) => {
  const { db, channelHost } = c.var.providers;
  const user = c.var.user;

  const botUsername = channelHost.botUsername("telegram");
  if (!channelHost.isRunning("telegram") || !botUsername) {
    return c.json({ error: "telegram bot not configured" }, 409);
  }

  const code = await mintLinkCode(db, user.id, "telegram");
  const resp: StartIdentityLinkResponse = {
    delivery: "deep_link",
    deepLink: `https://t.me/${botUsername}?start=${code}`,
    expiresInSeconds: START_LINK_TTL_SECONDS,
  };
  return c.json(resp);
});

identityLinksRouter.get("/slack/users", async (c) => {
  const { channelHost } = c.var.providers;
  const transport = channelHost.transportFor("slack");
  if (!transport || !hasSlackLinkExtras(transport)) {
    return c.json({ error: "slack bot not configured" }, 409);
  }
  // Require a real query server-side (not just in the UI): an empty/1-char q
  // returns the first page of the directory, an unintended enumeration surface
  // for any authenticated member. The user searches for their own handle, so a
  // 2-char floor costs them nothing.
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) {
    const empty: ListSlackWorkspaceMembersResponse = { members: [] };
    return c.json(empty);
  }
  const members = await transport.listWorkspaceMembers(q);
  const resp: ListSlackWorkspaceMembersResponse = { members };
  return c.json(resp);
});

identityLinksRouter.post("/slack/start", async (c) => {
  const { db, channelHost } = c.var.providers;
  const user = c.var.user;

  const transport = channelHost.transportFor("slack");
  if (!transport || !hasSlackLinkExtras(transport)) {
    return c.json({ error: "slack bot not configured" }, 409);
  }

  let body: StartSlackIdentityLinkRequest;
  try {
    body = (await c.req.json()) as StartSlackIdentityLinkRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.externalId !== "string" || body.externalId === "") {
    return c.json({ error: "externalId is required" }, 400);
  }

  const now = Date.now();
  const last = slackStartAt.get(user.id);
  if (last !== undefined && now - last < SLACK_START_COOLDOWN_MS) {
    return c.json({ error: "slow down — wait a moment before requesting another Slack link code" }, 429);
  }

  // Send the DM before recording the cooldown: a transient Slack failure
  // should surface as a clean 502 the caller can retry immediately, not a 500
  // that also locks them out for the cooldown window with no DM delivered.
  const code = await mintLinkCode(db, user.id, "slack", { externalId: body.externalId });
  try {
    const conversationKey = await transport.openDirectConversation(body.externalId);
    await transport.send(conversationKey, {
      markdown: `Your Valet link code is **${code}** — enter it in Settings → Connected accounts. It expires in 10 minutes. If you didn't request this, ignore it.`,
    });
  } catch (err) {
    console.error("[identity-links] slack link-code DM failed", err);
    return c.json({ error: "couldn't DM the link code to that Slack account — try again" }, 502);
  }
  slackStartAt.set(user.id, now);

  const resp: StartIdentityLinkResponse = { delivery: "dm_code", expiresInSeconds: START_LINK_TTL_SECONDS };
  return c.json(resp);
});

identityLinksRouter.post("/slack/verify", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: VerifyIdentityLinkRequest;
  try {
    body = (await c.req.json()) as VerifyIdentityLinkRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.code !== "string" || body.code === "") {
    return c.json({ error: "code is required" }, 400);
  }

  const consumed = await consumeLinkCode(db, "slack", body.code);
  // The code was minted BY this user and DMed to the Slack account they
  // chose; requiring the same web user to redeem it closes the loop.
  if (!consumed || consumed.userId !== user.id || !consumed.externalId) {
    return c.json({ error: "invalid or expired code" }, 400);
  }

  await linkIdentity(db, { provider: "slack", externalId: consumed.externalId, userId: user.id });

  const resp: VerifyIdentityLinkResponse = { ok: true };
  return c.json(resp);
});

identityLinksRouter.patch("/:provider", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const provider = c.req.param("provider");

  let body: PatchIdentityLinkRequest;
  try {
    body = (await c.req.json()) as PatchIdentityLinkRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.notifyAttention !== "boolean") {
    return c.json({ error: "notifyAttention must be a boolean" }, 400);
  }

  const existing = await identityForUser(db, provider, user.id);
  if (!existing) {
    return c.json({ error: "not linked" }, 404);
  }

  await setNotifyAttention(db, provider, user.id, body.notifyAttention);

  const resp: PatchIdentityLinkResponse = { ok: true };
  return c.json(resp);
});

identityLinksRouter.delete("/:provider", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  await unlinkIdentity(db, c.req.param("provider"), user.id);

  const resp: DeleteIdentityLinkResponse = { ok: true };
  return c.json(resp);
});
