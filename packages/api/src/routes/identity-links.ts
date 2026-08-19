/**
 * `/api/me/identity-links` — per-user channel account linking (Phase 7).
 * Provider-parameterized: each `ValetPlugin` with an `identityLink` field
 * declares one provider. `GET` lists all declaring plugins; `POST .../start`
 * mints a short-lived link code and returns a deep link when the provider
 * supports it; `POST .../deliver` mints a code and DMs it to the caller via
 * an email lookup or to a member picked from `GET .../members`; `PATCH`
 * flips `notifyAttention`; `DELETE` unlinks (always 200, same idempotent
 * convention as `/api/credentials`).
 *
 * Mounted BEFORE `/api/me` in `app.ts` so the longer, more specific prefix
 * wins under Hono's route matching.
 */
import { Hono } from "hono";
import {
  ChannelLookupError,
  type ChannelTransport,
  type ValetPlugin,
  type IdentityLinkDeclaration,
} from "@valet/engine";
import type { AppEnv } from "../env.js";
import { hasOpenDirect } from "../channels/host.js";
import {
  identityForUser,
  mintLinkCode,
  setNotifyAttention,
  unlinkIdentity,
} from "../channels/identity-links.js";
import type {
  DeleteIdentityLinkResponse,
  DeliverIdentityLinkFallback,
  DeliverIdentityLinkRequest,
  DeliverIdentityLinkResponse,
  IdentityLinkStatus,
  LinkMemberEntry,
  ListIdentityLinksResponse,
  ListLinkMembersResponse,
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

/** True when `POST .../deliver` can work: the plugin declares the DM text
 * and the running transport can resolve a member by email. */
function canDeliverCode(decl: IdentityLinkDeclaration, transport: ChannelTransport | null): boolean {
  return decl.deliveryDm !== undefined && typeof transport?.lookupUserByEmail === "function";
}

identityLinksRouter.get("/", async (c) => {
  const { db, channelHost, plugins } = c.var.providers;
  const user = c.var.user;

  const declarations = linkDeclarations(plugins);
  const links: IdentityLinkStatus[] = [];

  for (const [provider, decl] of declarations) {
    const identity = await identityForUser(db, provider, user.id);
    const transport = channelHost.transportFor(provider);
    const channelReady = channelHost.isRunning(provider);
    const codeDelivery = channelReady && canDeliverCode(decl, transport);
    const memberSearch = channelReady && typeof transport?.listWorkspaceMembers === "function";
    const link: IdentityLinkStatus = identity
      ? {
          provider,
          linked: true,
          externalId: identity.externalId,
          notifyAttention: identity.notifyAttention,
          createdAt: identity.createdAt,
          channelReady,
          codeDelivery,
          memberSearch,
        }
      : {
          provider,
          linked: false,
          channelReady,
          codeDelivery,
          memberSearch,
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

/**
 * POST `/:provider/deliver` — the "DM me the code" flow. With no body, it
 * resolves the caller in the provider workspace by their Valet email. With
 * `{ externalId }` (the "find me by name" fallback), it DMs the member the
 * caller picked from `GET .../members`. Either way it mints a link code and
 * DMs the provider's `deliveryDm` text. The user completes the link the
 * same way as the show-code flow: they send `link <code>` to the bot — the
 * DM just puts that line one reply away.
 *
 * Sending to a picked member is safe because the DM alone links nothing:
 * the link happens only when the recipient replies from their own account,
 * and the `deliveryDm` text tells an unexpecting recipient to ignore it.
 *
 * Outcomes:
 * - 200 `DeliverIdentityLinkResponse` — DM sent; body echoes the exact text.
 * - 202 `{ reason: "email_not_in_workspace" }` — the email names nobody;
 *   the client falls back to member search or show-code. Not an error.
 * - 400 — bad body, or the bot is missing a lookup scope (an admin can fix it).
 * - 404/409 — unknown provider, delivery unsupported, or transport down.
 * - 502 — the provider API failed.
 */
identityLinksRouter.post("/:provider/deliver", async (c) => {
  const { db, channelHost, plugins } = c.var.providers;
  const user = c.var.user;
  const provider = c.req.param("provider");

  const decl = linkDeclarations(plugins).get(provider);
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
  const transport = channelHost.transportFor(provider);
  const deliveryDm = decl.deliveryDm;
  if (transport === null || deliveryDm === undefined || typeof transport.lookupUserByEmail !== "function") {
    return c.json(
      { error: `${provider} does not support code delivery by DM. Use the show-code flow instead.` },
      404,
    );
  }

  // Optional body: `{ externalId }` skips the email lookup (find-me-by-name).
  let body: DeliverIdentityLinkRequest = {};
  const raw = await c.req.text();
  if (raw !== "") {
    try {
      body = JSON.parse(raw) as DeliverIdentityLinkRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
  }
  // A present-but-wrong-typed field is a caller bug — reject it instead of
  // silently taking the email path.
  if (body.externalId !== undefined && (typeof body.externalId !== "string" || body.externalId === "")) {
    return c.json({ error: "externalId must be a non-empty string" }, 400);
  }
  if (body.displayName !== undefined && typeof body.displayName !== "string") {
    return c.json({ error: "displayName must be a string" }, 400);
  }

  let match: { externalId: string; displayName: string } | null = null;
  if (body.externalId !== undefined) {
    match = {
      externalId: body.externalId,
      displayName: body.displayName !== undefined && body.displayName !== "" ? body.displayName : body.externalId,
    };
  } else {
    try {
      match = user.email === "" ? null : await transport.lookupUserByEmail(user.email);
    } catch (err) {
      if (err instanceof ChannelLookupError && err.kind === "missing_scope") {
        return c.json({ error: err.message }, 400);
      }
      return c.json(
        { error: err instanceof Error ? err.message : `${provider} member lookup failed.` },
        502,
      );
    }
    if (match === null) {
      const fallback: DeliverIdentityLinkFallback = { reason: "email_not_in_workspace" };
      return c.json(fallback, 202);
    }
  }

  const code = await mintLinkCode(db, user.id, provider);
  const messageText = deliveryDm({ code });
  try {
    // Same default key shape as ChannelHost.attentionDeliverer: a transport
    // without openDirectConversation (Telegram) addresses a user by
    // `${channelType}:dm:${externalId}` — the sender id IS the address.
    const conversationKey = hasOpenDirect(transport)
      ? await transport.openDirectConversation(match.externalId)
      : `${provider}:dm:${match.externalId}`;
    await transport.send(conversationKey, { markdown: messageText });
  } catch (err) {
    // The minted code is now unreachable, and that is fine: it is stored as
    // a hash, expires in ten minutes, and the next mint for this user +
    // provider replaces it. No rollback needed. The client falls back to
    // the show-code flow, which mints that replacement.
    return c.json(
      {
        error: `Could not send the ${provider} DM: ${err instanceof Error ? err.message : "unknown error"}. Use the link code shown on the card instead.`,
      },
      502,
    );
  }

  const resp: DeliverIdentityLinkResponse = {
    delivered: true,
    externalId: match.externalId,
    displayName: match.displayName,
    messageText,
    code,
    expiresInSeconds: START_LINK_TTL_SECONDS,
  };
  return c.json(resp);
});

/**
 * GET `/:provider/members?query=` — workspace-member typeahead for the
 * "find me by name" fallback. Any linked-capable member may search: the
 * same directory is visible to them inside the provider app itself.
 */
identityLinksRouter.get("/:provider/members", async (c) => {
  const { channelHost, plugins } = c.var.providers;
  const provider = c.req.param("provider");
  const query = c.req.query("query") ?? "";

  if (!linkDeclarations(plugins).has(provider)) {
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
  const transport = channelHost.transportFor(provider);
  if (transport === null || typeof transport.listWorkspaceMembers !== "function") {
    return c.json({ error: `${provider} does not support member search.` }, 404);
  }

  let members: LinkMemberEntry[];
  try {
    const found = await transport.listWorkspaceMembers(query);
    members = found.map((m) => ({
      externalId: m.id,
      displayName: m.realName ?? m.name,
      handle: m.name,
    }));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : `${provider} member search failed.` },
      502,
    );
  }

  const resp: ListLinkMembersResponse = { members };
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
