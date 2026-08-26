/**
 * `/api/credentials` — manual token entry + connection summary for the
 * connect UI (plugin-system-v2 plan Task 15). OAuth connect/callback lives
 * in `routes/credential-connect.ts` (integration-oauth design); this file
 * remains the manual-entry and summary surface for every service,
 * including oauth2-typed credentials once connected. Owner defaults to the
 * authenticated caller's `user:{id}`
 * scope — same `CredentialOwner` shape `plugins/action-invoker.ts` and the
 * engine's `Session.credentialProvider` read at call time. `PUT`'s optional
 * `scope: "org"` body field (and `GET`/`DELETE`'s `?scope=org` query param)
 * maps the owner to `{type:"org", id:user.orgId}` instead — org admins only
 * (403 `"org admin required"` otherwise, matching `routes/org.ts`'s copy).
 * This is how an org admin pastes a shared credential (e.g. a Telegram bot
 * token `ChannelHost` resolves at `{type:"org",id}`) rather than a personal
 * one.
 *
 * `GET` never returns secret material — only `type`/`scopes`/`connectedAt`
 * plus a health-relevant whitelist (`expiresAt`, `metadata.login`,
 * `metadata.identityOnly`, `metadata.refreshFailedAt` — see
 * `services/github-tokens.ts`'s "healthy" definition, which these fields
 * mirror; the connect UI's health badges read them). `metadata` itself is
 * NEVER spread wholesale into the summary — only these four named fields,
 * so a future credential type whose `metadata` happens to carry
 * secret-shaped data can't leak through this route by accident. `list()`
 * doesn't carry `type`, so this reads each entry back through `get()` to
 * report it — an N+1 over a small per-user list, traded for not widening
 * the `CredentialStore` port's `list` return shape for one read-only
 * field.
 *
 * `PUT` validates exactly one of `accessToken`/`apiKey` is present —
 * `refreshToken` is additionally accepted, but only for `type: "oauth2"`.
 * The `service` path param isn't validated against any plugin's declared
 * credential services: `CredentialStore` has no notion of "known" services
 * (it's a flat owner+service keyspace), and rejecting unknown services here
 * would just be a static allowlist this route has no other reason to own.
 * `DELETE` is idempotent for the same reason — deleting an unconnected
 * service 200s rather than 404ing.
 *
 * One service is checked before it is stored: `slack` at `scope: "org"`.
 * That credential drives the Slack agent surface, whose misconfigurations
 * are all silent, so the route validates the token and signing secret
 * against Slack and records the workspace identity. See
 * `services/slack-connect.ts`.
 */
import { Hono } from "hono";
import type { CredentialOwner, StoredCredential } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { requiredScopeError, verifySlackBotToken } from "../services/slack-connect.js";
import { connectModeFor, findCredentialDeclaration } from "../services/integration-availability.js";
import { ONEPASSWORD_SERVICE, OnePasswordAuthError, onePasswordMeta } from "../services/onepassword.js";
import { getAllowPersonalOnePassword } from "../services/org.js";
import type {
  CredentialSummary,
  DeleteCredentialResponse,
  ListCredentialsResponse,
  PutCredentialRequest,
  PutCredentialResponse,
} from "../wire/types.js";

export const credentialsRouter = new Hono<AppEnv>();

const CREDENTIAL_TYPES: PutCredentialRequest["type"][] = ["oauth2", "api_key", "bot_token", "service_account"];

const ORG_ADMIN_REQUIRED = { error: "org admin required" } as const;
const PERSONAL_DISABLED = { error: "personal 1Password tokens are disabled by your organization" } as const;
const ONEPASSWORD_REFERENCE_TYPES: PutCredentialRequest["type"][] = ["api_key", "oauth2"];

function ownerFor(user: { id: string; orgId: string }, scope: "user" | "org"): CredentialOwner {
  return scope === "org" ? { type: "org", id: user.orgId } : { type: "user", id: user.id };
}

function isCredentialKind(type: StoredCredential["type"]): type is PutCredentialRequest["type"] {
  return (CREDENTIAL_TYPES as StoredCredential["type"][]).includes(type);
}

credentialsRouter.get("/", async (c) => {
  const { engineCredentials } = c.var.providers;
  const user = c.var.user;
  const scope = c.req.query("scope") === "org" ? "org" : "user";
  if (scope === "org" && user.role !== "admin") {
    return c.json(ORG_ADMIN_REQUIRED, 403);
  }
  const owner = ownerFor(user, scope);

  const listed = await engineCredentials.list(owner);
  const credentials: CredentialSummary[] = [];
  for (const item of listed) {
    const stored = await engineCredentials.get(owner, item.service);
    if (!stored) continue; // deleted between list() and get() — skip rather than error
    // `StoredCredential.type` additionally allows `"app_install"` (a legacy
    // worker-only kind — GitHub App installs — never written through this
    // manual-token surface, whose `PUT` validates against `CREDENTIAL_TYPES`
    // below). Skip rather than widen `CredentialKind` for a kind this route
    // can neither create nor manage.
    if (!isCredentialKind(stored.type)) continue;
    const metadata = stored.metadata;
    credentials.push({
      service: item.service,
      type: stored.type,
      scopes: item.scopes,
      connectedAt: item.connectedAt,
      expiresAt: stored.expiresAt,
      login: typeof metadata?.login === "string" ? metadata.login : undefined,
      identityOnly: metadata?.identityOnly === true ? true : undefined,
      refreshFailedAt: typeof metadata?.refreshFailedAt === "number" ? metadata.refreshFailedAt : undefined,
      onepasswordRef: onePasswordMeta(stored)?.reference,
    });
  }

  const resp: ListCredentialsResponse = { credentials };
  return c.json(resp);
});

credentialsRouter.put("/:service", async (c) => {
  const { engineCredentials, onePassword, db } = c.var.providers;
  const user = c.var.user;
  const service = c.req.param("service");

  let body: PutCredentialRequest;
  try {
    body = (await c.req.json()) as PutCredentialRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const scope = body.scope === "org" ? "org" : "user";
  if (scope === "org" && user.role !== "admin") {
    return c.json(ORG_ADMIN_REQUIRED, 403);
  }
  const owner = ownerFor(user, scope);

  // Availability gate (integration-availability design): a user-scope save
  // for a declared service whose deployment/org prerequisite is missing is
  // rejected — the token could never power a working integration. Org-scope
  // saves stay open (an admin's org save IS the configuration step), and
  // services with no declaration stay accepted per the note above.
  if (scope === "user") {
    const declared = findCredentialDeclaration(c.var.providers.plugins, service);
    if (declared) {
      const mode = await connectModeFor({
        plugins: c.var.providers.plugins,
        decl: declared,
        service,
        orgId: user.orgId,
        credentials: engineCredentials,
        env: process.env,
      });
      if (mode === "unconfigured") {
        return c.json(
          { error: `${service} is not configured for this organization. An admin can set it up in Settings → Organization.` },
          403,
        );
      }
      // "org": the org credential IS the integration and sessions resolve
      // it by owner escalation, so a personal token adds nothing a member
      // should paste. The personal path, when one exists, is its own
      // declaration (e.g. slack-user OAuth).
      if (mode === "org") {
        return c.json(
          { error: `${service} is provided by your organization and needs no personal token. An admin manages it in Settings → Organization.` },
          403,
        );
      }
    }
  }

  if (!CREDENTIAL_TYPES.includes(body.type)) {
    return c.json({ error: `type must be one of ${CREDENTIAL_TYPES.join("|")}` }, 400);
  }

  // `metadata.onepassword` is a write-once-by-this-route field: the ONLY
  // place a `{reference, tokenScope}` pair may land in a stored credential's
  // metadata is the validated `body.onepassword` branch below, which runs
  // save-time `resolveReference` + the type/mutual-exclusion checks before
  // persisting it. `host.ts`'s resolver seam keys purely off
  // `onePasswordMeta(stored)` reading `metadata.onepassword` — an
  // unvalidated `metadata.onepassword` smuggled in through the plain path
  // would get live-resolved at read time with none of those guarantees.
  // Reject rather than silently strip, and unconditionally (regardless of
  // whether `body.onepassword` is ALSO present) — a caller sending both is
  // an ambiguous request, not a merge to resolve implicitly.
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) && "onepassword" in body.metadata) {
    return c.json({ error: "metadata.onepassword is reserved; use the onepassword request field" }, 400);
  }

  if (body.onepassword) {
    // Structural validation (reserved service name) takes precedence over
    // the personal-toggle policy check below — a request naming the
    // reserved service is malformed regardless of the org's toggle state.
    if (service === ONEPASSWORD_SERVICE) {
      return c.json({ error: "onepassword is a reserved service name" }, 400);
    }
    // `github` is resolved through `services/session-github-token.ts` at
    // session-build time (`host.ts`'s `buildCredentialResolver`), which
    // takes the `github`-service branch unconditionally when `githubTokenDeps`
    // + `db` are wired — an onepassword-reference row stored here would be
    // silently ignored, never resolved. Reject at write time instead of
    // shipping a credential nothing reads.
    if (service === "github") {
      return c.json({ error: "github credentials cannot be 1Password references; use the GitHub connect flow" }, 400);
    }
    const hasInlineSecret =
      (typeof body.accessToken === "string" && body.accessToken.length > 0) ||
      (typeof body.apiKey === "string" && body.apiKey.length > 0);
    if (hasInlineSecret) {
      return c.json({ error: "onepassword reference and inline secret are mutually exclusive" }, 400);
    }
    if (!ONEPASSWORD_REFERENCE_TYPES.includes(body.type)) {
      return c.json({ error: `type must be one of ${ONEPASSWORD_REFERENCE_TYPES.join("|")} for an onepassword reference` }, 400);
    }
    const { reference, tokenScope } = body.onepassword;
    if (tokenScope === "personal") {
      const allowed = await getAllowPersonalOnePassword(db, user.orgId);
      if (!allowed) {
        return c.json(PERSONAL_DISABLED, 403);
      }
    }

    try {
      await onePassword.resolveReference(tokenScope, { orgId: user.orgId, userId: user.id }, reference);
    } catch (err) {
      if (err instanceof OnePasswordAuthError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const credential: StoredCredential = {
      type: body.type,
      metadata: { ...body.metadata, onepassword: body.onepassword },
    };
    await engineCredentials.save(owner, service, credential);
    const resp: PutCredentialResponse = { ok: true };
    return c.json(resp);
  }

  // Plain token write to the reserved `onepassword` service — the caller's
  // own personal service-account token. Gated by the same org toggle a
  // `onepassword`-reference credential's `tokenScope: "personal"` is. Only
  // reached when `body.onepassword` is absent — see the reserved-service
  // 400 above, which takes precedence when it's present.
  if (service === ONEPASSWORD_SERVICE && scope === "user") {
    const allowed = await getAllowPersonalOnePassword(db, user.orgId);
    if (!allowed) {
      return c.json(PERSONAL_DISABLED, 403);
    }
  }

  const accessToken = typeof body.accessToken === "string" && body.accessToken.length > 0 ? body.accessToken : undefined;
  const apiKey = typeof body.apiKey === "string" && body.apiKey.length > 0 ? body.apiKey : undefined;
  if (!accessToken && !apiKey) {
    return c.json({ error: "exactly one of accessToken or apiKey is required" }, 400);
  }
  if (accessToken && apiKey) {
    return c.json({ error: "accessToken and apiKey are mutually exclusive" }, 400);
  }
  if (body.refreshToken !== undefined && body.type !== "oauth2") {
    return c.json({ error: "refreshToken is only accepted for type=\"oauth2\"" }, 400);
  }

  const credential: StoredCredential = {
    type: body.type,
    accessToken,
    apiKey,
    refreshToken: body.type === "oauth2" ? body.refreshToken : undefined,
    metadata: body.metadata,
  };

  // The org Slack credential drives the agent surface, so it is checked
  // against Slack before it is stored. Every failure this catches is
  // otherwise invisible: a wrong signing secret only shows up as 401s on an
  // unauthenticated webhook, and a missing scope only shows up hours later
  // on one API call. The check also records the workspace identity the rest
  // of the integration depends on. A user-scoped Slack credential is a
  // personal token for the action plugin and is not checked here.
  if (service === "slack" && scope === "org") {
    const webhookSecret = credential.metadata?.webhookSecret;
    if (typeof webhookSecret !== "string" || webhookSecret === "") {
      return c.json(
        { error: "Slack needs metadata.webhookSecret. Copy the Signing Secret from Basic Information in your Slack app settings." },
        400,
      );
    }
    // `accessToken` and `apiKey` are already known to be exactly one of the
    // two at this point.
    const token = accessToken ?? apiKey ?? "";
    const check = await verifySlackBotToken(token);
    if (!check.ok) return c.json({ error: check.error }, 400);
    const scopeError = requiredScopeError(check.identity.grantedScopes);
    if (scopeError) return c.json({ error: scopeError }, 400);

    credential.metadata = {
      ...credential.metadata,
      // The webhook route answers this workspace and drops every other one.
      // A shared app's signing secret is valid for every workspace that
      // installs the app, so this id is the workspace boundary.
      teamId: check.identity.teamId,
      teamName: check.identity.teamName,
      botUserId: check.identity.botUserId,
    };
    // Recorded so the setup route can report missing optional scopes without
    // calling Slack again. `undefined` when Slack sent no scope header.
    credential.scopes = check.identity.grantedScopes ?? undefined;
  }

  await engineCredentials.save(owner, service, credential);

  const resp: PutCredentialResponse = { ok: true };
  return c.json(resp);
});

credentialsRouter.delete("/:service", async (c) => {
  const { engineCredentials } = c.var.providers;
  const user = c.var.user;
  const scope = c.req.query("scope") === "org" ? "org" : "user";
  if (scope === "org" && user.role !== "admin") {
    return c.json(ORG_ADMIN_REQUIRED, 403);
  }
  const owner = ownerFor(user, scope);
  const service = c.req.param("service");

  await engineCredentials.delete(owner, service);

  const resp: DeleteCredentialResponse = { ok: true };
  return c.json(resp);
});
