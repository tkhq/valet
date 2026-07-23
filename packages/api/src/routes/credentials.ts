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
 */
import { Hono } from "hono";
import type { CredentialOwner, StoredCredential } from "@valet/engine";
import type { AppEnv } from "../env.js";
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
    });
  }

  const resp: ListCredentialsResponse = { credentials };
  return c.json(resp);
});

credentialsRouter.put("/:service", async (c) => {
  const { engineCredentials } = c.var.providers;
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

  if (!CREDENTIAL_TYPES.includes(body.type)) {
    return c.json({ error: `type must be one of ${CREDENTIAL_TYPES.join("|")}` }, 400);
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

  // Slack org connect (slack design decision 1): the bot token + signing
  // secret pair is validated at save time — a bad signing secret otherwise
  // fails silently as 403s on every webhook — and `auth.test` populates the
  // workspace identity the transport and webhook route rely on
  // (`metadata.teamId` for the conversation-key codec and foreign-team
  // rejection, `botUserId` for echo suppression).
  if (service === "slack" && scope === "org") {
    const token = accessToken ?? apiKey;
    const webhookSecret = credential.metadata?.webhookSecret;
    if (typeof webhookSecret !== "string" || webhookSecret === "") {
      return c.json({ error: "slack requires metadata.webhookSecret (the app signing secret)" }, 400);
    }
    const apiBase = process.env.VALET_SLACK_API_BASE ?? "https://slack.com/api";
    let auth: Record<string, unknown>;
    try {
      const res = await fetch(`${apiBase}/auth.test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      auth = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      return c.json({ error: `slack token validation failed: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
    if (auth.ok !== true) {
      return c.json({ error: `slack token rejected: ${typeof auth.error === "string" ? auth.error : "auth.test failed"}` }, 400);
    }
    // Must be a BOT token: the channel posts as the app and echo-suppresses on
    // its bot user id. auth.test succeeds for a user (xoxp) token too, but then
    // botUserId would be a human and the transport would post as that person.
    // Bot tokens carry a bot_id in the auth.test response; user tokens don't.
    if (typeof auth.bot_id !== "string") {
      return c.json({ error: "slack requires a bot token (xoxb-…), not a user token" }, 400);
    }
    credential.metadata = {
      ...credential.metadata,
      teamId: typeof auth.team_id === "string" ? auth.team_id : undefined,
      teamName: typeof auth.team === "string" ? auth.team : undefined,
      botUserId: typeof auth.user_id === "string" ? auth.user_id : undefined,
    };
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
