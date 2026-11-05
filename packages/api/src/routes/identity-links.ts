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
import { authCodeEnvReady, findOAuthDeclaration } from "../services/integration-oauth.js";
import {
  CODE_TTL_MS,
  consumeDeliveredLinkCode,
  identityForExternal,
  identityForUser,
  linkIdentity,
  mintDeliveredLinkCode,
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
  VerifyIdentityLinkRequest,
  VerifyIdentityLinkResponse,
  StartIdentityLinkResponse,
} from "../wire/types.js";

export const identityLinksRouter = new Hono<AppEnv>();

// Derived, not declared: the enforced TTL lives with mint/consume in
// channels/identity-links.ts, so the advertised expiry cannot drift from it.
const START_LINK_TTL_SECONDS = CODE_TTL_MS / 1000;

/** Builds a map from provider key to declaration for all declaring plugins. */
function linkDeclarations(plugins: ValetPlugin[]): Map<string, IdentityLinkDeclaration> {
  const map = new Map<string, IdentityLinkDeclaration>();
  for (const plugin of plugins) {
    if (plugin.identityLink) map.set(plugin.identityLink.provider, plugin.identityLink);
  }
  return map;
}

/** True when `POST .../deliver` can work: the plugin declares the DM and
 * the running transport can resolve a member by email. */
function canDeliverCode(decl: IdentityLinkDeclaration, transport: ChannelTransport | null): boolean {
  return decl.deliveryDm !== undefined && typeof transport?.lookupUserByEmail === "function";
}

/** The declared OAuth service that also writes this identity link, when the
 * deployment can run its authorization-code flow. A missing client id or
 * secret hides the option: the connect route would fail. */
function linkingOAuthService(plugins: ValetPlugin[], decl: IdentityLinkDeclaration): string | undefined {
  if (!decl.oauthService) return undefined;
  const found = findOAuthDeclaration(plugins, decl.oauthService);
  if (!found || found.oauth.mode !== "authorization_code") return undefined;
  return authCodeEnvReady(found.oauth, process.env) ? decl.oauthService : undefined;
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
    const oauthService = linkingOAuthService(plugins, decl);
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
          ...(oauthService ? { oauthService } : {}),
        }
      : {
          provider,
          linked: false,
          channelReady,
          codeDelivery,
          memberSearch,
          ...(oauthService ? { oauthService } : {}),
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
 * POST `/:provider/deliver` — the "DM me" flow. With no body, it resolves
 * the caller in the provider workspace by their Valet email. With
 * `{ externalId }` (the "find me by name" fallback), it DMs the member the
 * caller picked from `GET .../members`. Either way it mints a code bound to
 * that account and to the caller, and DMs it. The person reads the code in
 * the DM and enters it through `POST .../verify` (the v1 flow).
 *
 * The code is never in this response: reading the DM is what proves control
 * of the account. It is also never redeemable from chat, so a picked member
 * who replies with it links nothing (`consumeLinkCode` skips bound codes).
 *
 * Outcomes:
 * - 200 `DeliverIdentityLinkResponse` — DM sent; the code is only in the DM.
 * - 202 `{ reason: "email_not_in_workspace" }` — the email names nobody;
 *   the client falls back to member search or show-code. Not an error.
 * - 400 — bad body, or the bot is missing a lookup scope (an admin can fix it).
 * - 404/409 — unknown provider, delivery unsupported, or transport down.
 * - 409 — the account is linked to another Valet user.
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
  const { deliveryDm } = decl;
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

  // An account another Valet user linked stays theirs (verify would refuse
  // it anyway). Refusing here also stops codes being DMed to that person.
  const owner = await identityForExternal(db, provider, match.externalId);
  if (owner && owner.userId !== user.id) {
    return c.json(
      { error: `That ${provider} account is linked to another Valet user. Ask them to unlink it, then try again.` },
      409,
    );
  }
  const code = await mintDeliveredLinkCode(db, user.id, provider, match.externalId);
  try {
    // Same default key shape as ChannelHost.attentionDeliverer: a transport
    // without openDirectConversation (Telegram) addresses a user by
    // `${channelType}:dm:${externalId}` — the sender id IS the address.
    const conversationKey = hasOpenDirect(transport)
      ? await transport.openDirectConversation(match.externalId)
      : `${provider}:dm:${match.externalId}`;
    // The code goes only into the DM (see IdentityLinkDeclaration.deliveryDm).
    await transport.send(conversationKey, { markdown: deliveryDm({ code }) });
  } catch (err) {
    // The minted code is now unreachable, and that is fine: it is stored as
    // a hash, expires in ten minutes, and the next mint for this user +
    // provider replaces it. No rollback needed. The client falls back to
    // the show-code flow, which mints that replacement.
    // (The mint above already replaced any earlier pending code.)
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
    expiresInSeconds: START_LINK_TTL_SECONDS,
  };
  return c.json(resp);
});

/**
 * POST `/:provider/verify` — completes the deliver flow. The caller enters
 * the code the bot DMed; a match links the account the code was DMed to.
 * The code is bound to the caller, so another signed-in user cannot redeem
 * it even if they see it.
 *
 * - 200 `VerifyIdentityLinkResponse` — linked.
 * - 400 — missing, wrong, or expired code.
 * - 404 — unknown provider.
 * - 409 — the DMed account is linked to another Valet user.
 */
identityLinksRouter.post("/:provider/verify", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = c.var.user;
  const provider = c.req.param("provider");
  if (!linkDeclarations(plugins).has(provider)) {
    return c.json({ error: `unknown identity provider "${provider}"` }, 404);
  }
  let body: Partial<VerifyIdentityLinkRequest>;
  try {
    body = (await c.req.json()) as Partial<VerifyIdentityLinkRequest>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const consumed = code === "" ? null : await consumeDeliveredLinkCode(db, user.id, provider, code);
  if (!consumed) {
    return c.json({ error: "That code is invalid or expired. Send yourself a new DM from this card." }, 400);
  }
  // Same rule as the OAuth connect (`identity_conflict`): an account another
  // Valet user linked stays theirs until they unlink it.
  const owner = await identityForExternal(db, provider, consumed.externalId);
  if (owner && owner.userId !== user.id) {
    return c.json(
      { error: `That ${provider} account is linked to another Valet user. Ask them to unlink it, then try again.` },
      409,
    );
  }
  const prior = await identityForUser(db, provider, user.id);
  await linkIdentity(db, {
    provider,
    externalId: consumed.externalId,
    userId: user.id,
    notifyAttention: prior?.notifyAttention ?? true,
  });
  const resp: VerifyIdentityLinkResponse = { linked: true, externalId: consumed.externalId };
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
