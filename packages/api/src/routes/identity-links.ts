/**
 * `/api/me/identity-links` — per-user channel account linking (Phase 7).
 * Provider-parameterized: each `ValetPlugin` with an `identityLink` field
 * declares one provider. `GET` lists all declaring plugins; `POST .../start`
 * mints a short-lived link code and returns a deep link when the provider
 * supports it; `PATCH` flips `notifyAttention`; `DELETE` unlinks (always 200,
 * same idempotent convention as `/api/credentials`).
 *
 * Mounted BEFORE `/api/me` in `app.ts` so the longer, more specific prefix
 * wins under Hono's route matching.
 */
import { Hono } from "hono";
import type { ValetPlugin, IdentityLinkDeclaration } from "@valet/engine";
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

/** Builds a map from provider key to declaration for all declaring plugins. */
function linkDeclarations(plugins: ValetPlugin[]): Map<string, IdentityLinkDeclaration> {
  const map = new Map<string, IdentityLinkDeclaration>();
  for (const plugin of plugins) {
    if (plugin.identityLink) map.set(plugin.identityLink.provider, plugin.identityLink);
  }
  return map;
}

identityLinksRouter.get("/", async (c) => {
  const { db, channelHost, plugins } = c.var.providers;
  const user = c.var.user;

  const declarations = linkDeclarations(plugins);
  const links: IdentityLinkStatus[] = [];

  for (const [provider, _decl] of declarations) {
    const identity = await identityForUser(db, provider, user.id);
    const link: IdentityLinkStatus = identity
      ? {
          provider,
          linked: true,
          externalId: identity.externalId,
          notifyAttention: identity.notifyAttention,
          createdAt: identity.createdAt,
          channelReady: channelHost.isRunning(provider),
        }
      : {
          provider,
          linked: false,
          channelReady: channelHost.isRunning(provider),
        };
    links.push(link);
  }

  const resp: ListIdentityLinksResponse = { links };
  return c.json(resp);
});

identityLinksRouter.post("/:provider/start", async (c) => {
  const { db, channelHost, plugins } = c.var.providers;
  const user = c.var.user;
  const provider = c.req.param("provider");

  const declarations = linkDeclarations(plugins);
  const decl = declarations.get(provider);
  if (!decl) {
    return c.json({ error: `unknown identity provider "${provider}"` }, 404);
  }

  if (!channelHost.isRunning(provider)) {
    return c.json(
      {
        error: `${provider} transport is not running. Configure the ${provider} bot token, then retry.`,
      },
      409,
    );
  }

  const code = await mintLinkCode(db, user.id, provider);

  let deepLink: string | undefined;
  if (decl.deepLink) {
    const dl = decl.deepLink({ botUsername: channelHost.botUsername(provider), code });
    if (dl !== null) deepLink = dl;
  }

  const resp: StartIdentityLinkResponse = {
    code,
    instructions: decl.instructions,
    expiresInSeconds: START_LINK_TTL_SECONDS,
    ...(deepLink !== undefined ? { deepLink } : {}),
  };
  return c.json(resp);
});

identityLinksRouter.patch("/:provider", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = c.var.user;
  const provider = c.req.param("provider");

  const declarations = linkDeclarations(plugins);
  if (!declarations.has(provider)) {
    return c.json({ error: `unknown identity provider "${provider}"` }, 404);
  }

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
  const { db, plugins } = c.var.providers;
  const user = c.var.user;
  const provider = c.req.param("provider");

  const declarations = linkDeclarations(plugins);
  if (!declarations.has(provider)) {
    return c.json({ error: `unknown identity provider "${provider}"` }, 404);
  }

  await unlinkIdentity(db, provider, user.id);

  const resp: DeleteIdentityLinkResponse = { ok: true };
  return c.json(resp);
});
