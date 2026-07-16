/**
 * `/api/credentials` — manual token entry for the connect UI
 * (plugin-system-v2 plan Task 15; OAuth flows are deliberately out of scope
 * this phase). Owner defaults to the authenticated caller's `user:{id}`
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
 * (mirrors `CredentialStore.list`'s own shape, which is already
 * secret-free). `list()` doesn't carry `type`, so this reads each entry
 * back through `get()` to report it — an N+1 over a small per-user list,
 * traded for not widening the `CredentialStore` port's `list` return shape
 * for one read-only field.
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
    credentials.push({
      service: item.service,
      type: stored.type,
      scopes: item.scopes,
      connectedAt: item.connectedAt,
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
