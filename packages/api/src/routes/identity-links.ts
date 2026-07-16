/**
 * `/api/me/identity-links` — per-user channel account linking (Phase 7).
 * Just `telegram` this pass: `GET` reports link status built from
 * `identityForUser` + `channelHost.isRunning`; `POST .../start` mints a
 * short-lived link code and returns a `t.me` deep link; `PATCH` flips
 * `notifyAttention`; `DELETE` unlinks (always 200, same idempotent
 * convention as `/api/credentials`).
 *
 * Mounted BEFORE `/api/me` in `app.ts` so the longer, more specific prefix
 * wins under Hono's route matching.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  identityForUser,
  mintLinkCode,
  setNotifyAttention,
  unlinkIdentity,
} from "../channels/identity-links.js";
import type {
  DeleteIdentityLinkResponse,
  IdentityLinkStatus,
  ListIdentityLinksResponse,
  PatchIdentityLinkRequest,
  PatchIdentityLinkResponse,
  StartIdentityLinkResponse,
} from "../wire/types.js";

export const identityLinksRouter = new Hono<AppEnv>();

const START_LINK_TTL_SECONDS = 600;

identityLinksRouter.get("/", async (c) => {
  const { db, channelHost } = c.var.providers;
  const user = c.var.user;

  const identity = await identityForUser(db, "telegram", user.id);
  const link: IdentityLinkStatus = identity
    ? {
        provider: "telegram",
        linked: true,
        externalId: identity.externalId,
        notifyAttention: identity.notifyAttention,
        createdAt: identity.createdAt,
        channelReady: channelHost.isRunning("telegram"),
      }
    : {
        provider: "telegram",
        linked: false,
        channelReady: channelHost.isRunning("telegram"),
      };

  const resp: ListIdentityLinksResponse = { links: [link] };
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
    deepLink: `https://t.me/${botUsername}?start=${code}`,
    expiresInSeconds: START_LINK_TTL_SECONDS,
  };
  return c.json(resp);
});

identityLinksRouter.patch("/telegram", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: PatchIdentityLinkRequest;
  try {
    body = (await c.req.json()) as PatchIdentityLinkRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.notifyAttention !== "boolean") {
    return c.json({ error: "notifyAttention must be a boolean" }, 400);
  }

  const existing = await identityForUser(db, "telegram", user.id);
  if (!existing) {
    return c.json({ error: "not linked" }, 404);
  }

  await setNotifyAttention(db, "telegram", user.id, body.notifyAttention);

  const resp: PatchIdentityLinkResponse = { ok: true };
  return c.json(resp);
});

identityLinksRouter.delete("/telegram", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  await unlinkIdentity(db, "telegram", user.id);

  const resp: DeleteIdentityLinkResponse = { ok: true };
  return c.json(resp);
});
