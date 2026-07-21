/**
 * `/api/org/linear` — org-level Linear workspace connection (event-system
 * plan, Task 9). Mirrors the `github-app.ts` admin routes + the
 * `github-connect.ts` OAuth-callback shape: an org admin authorizes Valet
 * against a Linear workspace (`actor=app`), the callback exchanges the code,
 * auto-creates a workspace webhook pointed at the generic event ingress
 * (`/webhooks/events/linear`, `routes/event-webhooks.ts`), stores the org
 * `linear` credential (with the webhook signing secret in `metadata` —
 * exactly where the ingest route reads it from), and upserts
 * `linear_installations` (the `workspaceId -> orgId` mapping the ingest
 * route resolves against).
 *
 * OAuth app credentials come from env (`LINEAR_CLIENT_ID` /
 * `LINEAR_CLIENT_SECRET`) — deployment-level config, unlike the GitHub App's
 * per-org manifest flow, because Linear OAuth apps are created once by the
 * operator. State signing reuses `lib/oauth-state.ts` with the same
 * `{ userId, orgId, nonce, exp }` payload as `github-connect.ts` — the
 * callback rejects a state minted for a different signed-in user.
 *
 * Every route (callback included — the admin's own browser lands there with
 * their session cookie, same model as `github-connect.ts`'s callback) is
 * behind `requireOrgAdmin`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { createLinearService, resolveLinearOauthUrl, type LinearService } from "../services/linear.js";
import { linearInstallations } from "../schema/index.js";

export const linearConnectRouter = new Hono<AppEnv>();

const LINEAR_CREDENTIAL_SERVICE = "linear";
const OAUTH_SCOPES = "read,write,admin";

interface ConnectState {
  userId: string;
  orgId: string;
  nonce: string;
  exp: number;
}

function verifyConnectState(state: string, key: Buffer, nowMs: number): ConnectState | null {
  return verifyState<ConnectState>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, orgId, nonce, exp } = payload;
    if (typeof userId !== "string" || typeof orgId !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (exp < nowMs) return null;
    return { userId, orgId, nonce, exp };
  });
}

interface OauthAppConfig {
  clientId: string;
  clientSecret: string;
}

/** `null` when the deployment has no Linear OAuth app configured. */
function loadOauthAppConfig(env: NodeJS.ProcessEnv): OauthAppConfig | null {
  const clientId = env.LINEAR_CLIENT_ID;
  const clientSecret = env.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Same fallback `github-app.ts`'s manifest route uses: the configured
 * public URL when there is one, else the request's own origin (local dev /
 * tests, where the API is reached directly). */
function apiBase(c: Context<AppEnv>): string {
  return publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin;
}

function callbackUrl(c: Context<AppEnv>): string {
  return `${apiBase(c)}/api/org/linear/callback`;
}

function linearService(config: OauthAppConfig): LinearService {
  return createLinearService(config, process.env);
}

linearConnectRouter.post("/connect", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const config = loadOauthAppConfig(process.env);
  if (!config) {
    return c.json({ error: "Linear OAuth is not configured: set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET" }, 503);
  }

  const user = c.var.user;
  const key = deriveSecretKey(c.var.providers.encryptionKey);
  const statePayload: ConnectState = {
    userId: user.id,
    orgId: user.orgId,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };
  const state = signState(statePayload, key);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl(c),
    response_type: "code",
    scope: OAUTH_SCOPES,
    state,
    actor: "app",
  });
  const url = `${resolveLinearOauthUrl(process.env)}/oauth/authorize?${params.toString()}`;
  return c.json({ url });
});

linearConnectRouter.get("/callback", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const config = loadOauthAppConfig(process.env);
  if (!config) {
    return c.json({ error: "Linear OAuth is not configured: set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET" }, 503);
  }

  const user = c.var.user;
  const { db, engineCredentials, encryptionKey } = c.var.providers;
  const key = deriveSecretKey(encryptionKey);
  const verified = verifyConnectState(state, key, Date.now());
  if (!verified) return c.json({ error: "invalid or expired state" }, 400);
  if (verified.userId !== user.id) {
    return c.json({ error: "this authorization was not started by the signed-in user" }, 400);
  }

  const service = linearService(config);
  let accessToken: string;
  let workspaceId: string;
  let workspaceName: string;
  let webhookId: string;
  const webhookSecret = randomBytes(32).toString("hex");
  try {
    ({ accessToken } = await service.exchangeCode(code, callbackUrl(c)));
    ({ workspaceId, workspaceName } = await service.fetchWorkspace(accessToken));
    ({ webhookId } = await service.createWebhook(accessToken, {
      url: `${apiBase(c)}/webhooks/events/linear`,
      secret: webhookSecret,
    }));
  } catch (err) {
    console.error("linear connect callback failed:", err);
    return c.json({ error: "failed to complete the Linear connection" }, 502);
  }

  await engineCredentials.save({ type: "org", id: verified.orgId }, LINEAR_CREDENTIAL_SERVICE, {
    type: "oauth2",
    accessToken,
    metadata: { webhookSecret, workspaceId },
  });

  const now = Date.now();
  const [existing] = await db
    .select()
    .from(linearInstallations)
    .where(and(eq(linearInstallations.orgId, verified.orgId), eq(linearInstallations.workspaceId, workspaceId)))
    .limit(1);
  if (existing) {
    await db
      .update(linearInstallations)
      .set({ workspaceName, webhookId, connectedBy: user.id, updatedAt: now })
      .where(eq(linearInstallations.id, existing.id));
  } else {
    await db.insert(linearInstallations).values({
      id: `lin_${randomUUID()}`,
      orgId: verified.orgId,
      workspaceId,
      workspaceName,
      webhookId,
      connectedBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  return c.redirect("/settings/organization/linear?setup=ok", 302);
});

linearConnectRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  const { db, engineCredentials } = c.var.providers;
  const cred = await engineCredentials.get({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  const [install] = await db
    .select()
    .from(linearInstallations)
    .where(eq(linearInstallations.orgId, orgId))
    .limit(1);

  return c.json({
    connected: cred !== null && install !== undefined,
    workspaceName: install?.workspaceName,
    webhookConfigured: typeof install?.webhookId === "string",
  });
});

linearConnectRouter.delete("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  const { db, engineCredentials } = c.var.providers;

  // Best-effort webhook cleanup: a transient Linear failure shouldn't block
  // disconnecting — an orphaned webhook just delivers to an ingress that no
  // longer resolves the workspace (204 no-op).
  const config = loadOauthAppConfig(process.env);
  const cred = await engineCredentials.get({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  if (config && cred?.accessToken) {
    const installs = await db.select().from(linearInstallations).where(eq(linearInstallations.orgId, orgId));
    const service = linearService(config);
    for (const install of installs) {
      if (!install.webhookId) continue;
      try {
        await service.deleteWebhook(cred.accessToken, install.webhookId);
      } catch (err) {
        console.error("linear disconnect: best-effort webhookDelete failed:", err);
      }
    }
  }

  await db.delete(linearInstallations).where(eq(linearInstallations.orgId, orgId));
  await engineCredentials.delete({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  return c.body(null, 204);
});
