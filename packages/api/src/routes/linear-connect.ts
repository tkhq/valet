/**
 * `/api/org/linear` — the organization's native Linear integration. It
 * follows the Slack model: paste, verify, store.
 *
 *   1. The admin creates a Linear OAuth app from a prefilled form. The form
 *      turns on the `client_credentials` grant and points the app's own
 *      webhook at `/webhooks/events/linear`.
 *   2. `PUT /` takes the app's client ID, client secret, and webhook signing
 *      secret. The server mints an app-actor token with `client_credentials`
 *      and reads the Linear workspace with it BEFORE it stores anything, the
 *      way the Slack save runs `auth.test`.
 *
 * There is no browser approval. Linear installs a private app in its own
 * workspace when it issues the `client_credentials` token, and an approval
 * screen for an installed app has no way back to Valet. The token is renewed
 * by `LinearAppTokenStore`. No `admin` scope is requested and no webhook is
 * created through the API: the app's webhook belongs to Linear. `DELETE /`
 * still removes webhooks that older connections created through
 * `webhookCreate`, best effort.
 *
 * Every route is behind `requireOrgAdmin`.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { isRecord } from "../lib/oauth-state.js";
import {
  createLinearService,
  LinearTokenError,
  LINEAR_WEBHOOK_RESOURCE_TYPES,
} from "../services/linear.js";
import {
  loadLinearAppConfig,
  LINEAR_APP_SERVICE,
  LINEAR_CLIENT_CREDENTIALS_GRANT,
  LINEAR_CREDENTIAL_SERVICE,
} from "../services/linear-app.js";
import { getLinearIngressStatus } from "../services/linear-ingress.js";
import { replaceCredential } from "../services/credential-insert.js";
import { orgs, linearInstallations } from "../schema/index.js";

export const linearConnectRouter = new Hono<AppEnv>();

/** Same fallback `github-app.ts`'s manifest route uses: the configured
 * public URL when there is one, else the request's own origin (local dev /
 * tests, where the API is reached directly). */
function apiBase(c: Context<AppEnv>): string {
  return publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin;
}

/** Linear requires every app to list a redirect URI, because the
 * authorization-code grant is mandatory on all apps. The prefilled form
 * registers this one. Valet never sends a browser to it. */
function callbackUrl(c: Context<AppEnv>): string {
  return `${apiBase(c)}/api/org/linear/callback`;
}

/** Linear only accepts a public `https://` webhook URL on an app, so there is
 * no URL to prefill without a configured public URL. */
function webhookUrl(): string | undefined {
  const base = publicUrlFromEnv(process.env);
  if (!base) return undefined;
  try {
    if (new URL(base).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return `${base.replace(/\/+$/, "")}/webhooks/events/linear`;
}

async function statusBody(c: Context<AppEnv>) {
  const { db, engineCredentials } = c.var.providers;
  const hook = webhookUrl();
  return {
    ...await getLinearIngressStatus(db, engineCredentials, c.var.user.orgId),
    redirectUri: callbackUrl(c),
    ...(hook ? { webhookUrl: hook } : {}),
    webhookResourceTypes: [...LINEAR_WEBHOOK_RESOURCE_TYPES],
  };
}

function readSecretField(body: Record<string, unknown>, field: string, max: number): string | null {
  const value = body[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** Names the fix for a refused `client_credentials` request and quotes
 * Linear's own reason, so a mismatch is visible instead of guessed. */
function tokenRefusalMessage(err: LinearTokenError): string {
  const fix = /does not support the client_credentials grant/i.test(err.detail ?? "")
    ? "In Linear, open the app's settings, turn on Client credentials, and save. Then connect again."
    : "Copy the client ID and client secret again from the app in Linear. Then connect again.";
  return err.detail ? `${fix} Linear said: ${err.detail}` : fix;
}

linearConnectRouter.put("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const body: unknown = await c.req.json().catch(() => null);
  const clientId = isRecord(body) ? readSecretField(body, "clientId", 512) : null;
  const clientSecret = isRecord(body) ? readSecretField(body, "clientSecret", 4096) : null;
  const webhookSecret = isRecord(body) ? readSecretField(body, "webhookSecret", 4096) : null;
  if (!clientId || !clientSecret || !webhookSecret) {
    return c.json({ error: "Enter the Linear app's client ID, client secret, and webhook signing secret." }, 400);
  }

  // Verify with Linear before storing anything, the way the Slack save runs
  // auth.test: mint the app-actor token, then read the workspace with it.
  const service = createLinearService({ clientId, clientSecret }, process.env);
  let token: { accessToken: string; expiresAt: number };
  let workspace: { workspaceId: string; workspaceName: string };
  try {
    token = await service.clientCredentialsToken();
  } catch (err) {
    if (err instanceof LinearTokenError && err.status >= 400 && err.status < 500) {
      console.warn("linear connect: Linear refused the client credentials grant:", err.message);
      return c.json({ error: tokenRefusalMessage(err) }, 400);
    }
    console.error("linear connect: client credentials request failed:", err);
    return c.json({ error: "Could not reach Linear to check the app. Try again." }, 502);
  }
  try {
    workspace = await service.fetchWorkspace(token.accessToken);
  } catch (err) {
    console.error("linear connect: workspace lookup failed:", err);
    return c.json({ error: "Linear issued a token but the workspace lookup failed. Try again." }, 502);
  }

  const user = c.var.user;
  const { db, encryptionKey } = c.var.providers;
  const saved = await db.transaction(async (tx) => {
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, user.orgId)).for("update");
    // One workspace per org: the org credential holds exactly one token.
    const installs = await tx.select().from(linearInstallations).where(eq(linearInstallations.orgId, user.orgId));
    const foreign = installs.find((i) => i.workspaceId !== workspace.workspaceId);
    if (foreign) {
      return c.json({ error: `Another Linear workspace (${foreign.workspaceName}) is connected. Disconnect it first.` }, 409);
    }
    const existing = installs.find((i) => i.workspaceId === workspace.workspaceId);

    // One id for this connection on both rows (`LinearAppConfig.connectionId`).
    const connectionId = randomUUID();
    await replaceCredential(tx, encryptionKey, { type: "org", id: user.orgId }, LINEAR_APP_SERVICE, {
      type: "service_account", apiKey: clientSecret, metadata: { clientId, connectionId },
    });
    await replaceCredential(tx, encryptionKey, { type: "org", id: user.orgId }, LINEAR_CREDENTIAL_SERVICE, {
      type: "oauth2",
      accessToken: token.accessToken,
      metadata: {
        webhookSecret,
        workspaceId: workspace.workspaceId,
        grant: LINEAR_CLIENT_CREDENTIALS_GRANT,
        tokenExpiresAt: token.expiresAt,
        connectionId,
      },
    });
    const now = Date.now();
    if (existing) {
      await tx.update(linearInstallations)
        .set({ workspaceName: workspace.workspaceName, connectedBy: user.id, updatedAt: now })
        .where(eq(linearInstallations.id, existing.id));
    } else {
      await tx.insert(linearInstallations).values({
        id: `lin_${randomUUID()}`,
        orgId: user.orgId,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        webhookId: null,
        connectedBy: user.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    return null;
  });
  if (saved) return saved;
  return c.json(await statusBody(c));
});

linearConnectRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  return c.json(await statusBody(c));
});

linearConnectRouter.delete("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  const { db, engineCredentials } = c.var.providers;

  // Connections made before the app-webhook model created their webhook
  // through `webhookCreate`. Remove those best effort: a failure must not
  // block disconnecting, and an orphaned webhook only reaches an ingress that
  // no longer resolves the workspace (204 no-op).
  const installs = await db.select().from(linearInstallations).where(eq(linearInstallations.orgId, orgId));
  const legacy = installs.filter((install) => install.webhookId);
  if (legacy.length > 0) {
    const config = await loadLinearAppConfig(engineCredentials, orgId);
    const cred = await engineCredentials.get({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
    if (config && cred?.accessToken) {
      const service = createLinearService(config, process.env);
      for (const install of legacy) {
        try {
          await service.deleteWebhook(cred.accessToken, install.webhookId!);
        } catch (err) {
          console.error(`linear disconnect: remove webhook ${install.webhookId} in Linear's settings; delete failed:`, err);
        }
      }
    }
  }

  // The app config goes first: a token renewal in flight checks it after its
  // save and removes the token it wrote (linear-app-token-store.ts).
  await engineCredentials.delete({ type: "org", id: orgId }, LINEAR_APP_SERVICE);
  await db.delete(linearInstallations).where(eq(linearInstallations.orgId, orgId));
  await engineCredentials.delete({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  return c.body(null, 204);
});
