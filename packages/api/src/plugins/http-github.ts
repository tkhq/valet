/**
 * Host capabilities for the GitHub plugin's HTTP routes. Storage stays in
 * `credentials` and `github_installations` until TKAI-378 decides plugin
 * storage. The shared App client stays in `services/github-app.ts`, because
 * token resolution, the installation sweep, and boot webhook sync use it.
 *
 * Each capability is bound to one host-derived identity:
 *
 *   - App administration: the authenticated caller's organization.
 *   - App setup: the organization in a setup state this host signed. The
 *     state also names the org admin who started setup, and a grant opens
 *     only for that caller while they are still an admin of that organization.
 *   - User connection: the authenticated caller. A callback grant opens only
 *     when the signed state names that caller.
 *
 * Each flow signs its state for its own purpose (`lib/oauth-state.ts`), so a
 * connect state or a credential-connect state never opens App setup.
 *   - Webhook effects: the organization that owns the App credential, or,
 *     for the `GITHUB_APP_*` fallback, the organization that synced the
 *     verified installation, else the oldest organization.
 *
 * ── Single-App caveat ───────────────────────────────────────────────────
 * GitHub signs webhook deliveries per App, and a delivery names no Valet
 * organization. This deployment is single-App and single-organization, so
 * the webhook scans `credentials` for the one organization `github_app` row.
 * If more than one organization stores an App in one deployment, deliveries
 * go to the first row. A multi-organization deployment needs a real
 * App-to-organization lookup.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PluginHttpCaller, PluginHttpRequest } from "@valet/engine";
import {
  appCredential,
  appDisconnect,
  appManifest,
  appRefresh,
  appSetup,
  appStatus,
  connectCallback,
  connectDisconnect,
  connectOrgStatus,
  connectStart,
  receiveWebhook,
  type GithubAppCapability,
  type GithubAppConfigInput,
  type GithubAppStatus,
  type GithubConnectionCapability,
  type GithubDeliveryEffects,
  type GithubEndpoints,
  type GithubOrgStatus,
  type GithubPostAuthDestination,
  type GithubSetupCapability,
  type GithubWebhookCapability,
} from "@valet/plugin-github/http";
import type { AppQueryable } from "../lib/drizzle.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState, STATE_TTL_MS } from "../lib/oauth-state.js";
import type { Providers } from "../providers/types.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { resolveReturnOrigin } from "../routes/credential-connect.js";
import { credentials, githubInstallations, orgs } from "../schema/index.js";
import { githubAppInstallUrl, resolveGithubApiUrl, resolveGithubUrl } from "../services/github-env.js";
import {
  buildAppConfig,
  discoverInstallations,
  loadAppConfig,
  loadAppConfigWithSource,
  relinkInstallations,
  resolveGithubAppEnvConfig,
  saveAppConfig,
  syncAppWebhookUrl,
  verifyAppCredential,
  type GithubAppDeps,
} from "../services/github-app.js";
import { invalidateWorkflowSources } from "../services/content-sync/invalidation.js";
import { isOrgAdmin } from "../services/org.js";
import { refreshCredentialReadiness } from "../services/credential-readiness.js";
import { deleteSharesFrom } from "../services/credential-shares.js";
import { setPullRequestState } from "../services/thread-pull-requests.js";
import { ingestEvent } from "../events/ingest.js";
import { writeDropLog } from "../orchestrator/signals.js";
import type { GetGithubAppResponse, GetGithubOrgStatusResponse } from "../wire/types.js";
import type { PluginHttpBinding, PluginHttpBindingContext } from "./http-bindings.js";

const GITHUB_CREDENTIAL_SERVICE = "github";

function endpoints(): GithubEndpoints {
  return {
    githubUrl: resolveGithubUrl(process.env),
    githubApiUrl: resolveGithubApiUrl(process.env),
    publicUrl: publicUrlFromEnv(process.env) ?? null,
  };
}

/** Every loaded trigger for the `github` service, from any plugin. */
function githubTriggers(providers: Providers) {
  return providers.plugins.flatMap((plugin) => plugin.triggers ?? []).filter((trigger) => trigger.service === "github");
}

/** The host mount supplies a caller for every user and org-admin route. */
function callerOf(context: PluginHttpBindingContext): PluginHttpCaller {
  if (!context.caller) throw new Error("This GitHub route needs an authenticated caller. Mount it with user or org-admin authentication.");
  return context.caller;
}

const app = (context: PluginHttpBindingContext) => appCapability(context.providers, callerOf(context), context.request);
const connection = (context: PluginHttpBindingContext) =>
  connectionCapability(context.providers, callerOf(context), context.request);

/** Host bindings for every GitHub route, by route ID. */
export const githubHttpBindings: Readonly<Record<string, PluginHttpBinding>> = {
  "app-status": { method: "GET", path: "/app", auth: "org-admin", bind: (context) => appStatus(app(context)) },
  "app-manifest": {
    method: "POST", path: "/app/manifest", auth: "org-admin",
    bind: (context) => appManifest(
      context.request, app(context), endpoints(), githubTriggers(context.providers).map((trigger) => trigger.id),
    ),
  },
  // The signed state names the organization. GitHub's redirect cannot carry
  // the org-admin check, so the capability repeats it for the admin the state names.
  "app-setup": {
    method: "GET", path: "/app/setup", auth: "user",
    bind: (context) => appSetup(context.request, setupCapability(context.providers, callerOf(context)), endpoints()),
  },
  "app-credential": {
    method: "POST", path: "/app/credential", auth: "org-admin",
    bind: (context) => appCredential(context.request, app(context)),
  },
  "app-refresh": {
    method: "POST", path: "/app/refresh", auth: "org-admin",
    bind: (context) => appRefresh(app(context)),
  },
  "app-disconnect": {
    method: "DELETE", path: "/app", auth: "org-admin",
    bind: (context) => appDisconnect(app(context)),
  },
  connect: {
    method: "POST", path: "/connection/connect", auth: "user",
    bind: (context) => connectStart(context.request, connection(context), endpoints()),
  },
  "org-status": {
    method: "GET", path: "/connection/org-status", auth: "user",
    bind: (context) => connectOrgStatus(connection(context)),
  },
  callback: {
    method: "GET", path: "/connection/callback", auth: "user",
    bind: (context) => connectCallback(context.request, connection(context), endpoints()),
  },
  disconnect: {
    method: "DELETE", path: "/connection", auth: "user",
    bind: (context) => connectDisconnect(connection(context)),
  },
  webhook: {
    method: "POST", path: "/webhook", auth: "public",
    bind: (context) => receiveWebhook(context.request, webhookCapability(context.providers), githubTriggers(context.providers)),
  },
};

function appDeps(providers: Providers): GithubAppDeps {
  const { db, engineCredentials, encryptionKey } = providers;
  return { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
}

function stateKey(providers: Providers): Buffer {
  return deriveSecretKey(providers.encryptionKey);
}

/** The browser origin to return to, captured at signing because the callback's referer is GitHub. */
function returnOrigin(request: PluginHttpRequest): string {
  return resolveReturnOrigin(request.url, request.headers.referer, process.env);
}

function toInstallationSummary(row: typeof githubInstallations.$inferSelect): GithubAppStatus["installations"][number] {
  return {
    id: row.id,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    suspended: row.suspended,
    linkedUserId: row.linkedUserId,
  };
}

async function readAppStatus(deps: GithubAppDeps, orgId: string): Promise<GithubAppStatus> {
  const loaded = await loadAppConfigWithSource(deps, orgId);
  const rows = await deps.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
  const body: GetGithubAppResponse = {
    configured: loaded !== null,
    source: loaded?.source,
    app: loaded
      ? {
          appId: loaded.config.appId,
          appSlug: loaded.config.appSlug,
          htmlUrl: loaded.config.htmlUrl,
          installUrl: githubAppInstallUrl(process.env, loaded.config.appSlug),
        }
      : undefined,
    installations: rows.map(toInstallationSummary),
    webhook: { mode: publicUrlFromEnv(process.env) ? "public" : "manual" },
    // `discoverInstallations` writes `updatedAt` on every upsert, so the
    // newest row dates the last successful read. Reduced here, because the
    // two drivers disagree on what `max()` over a bigint column returns.
    installationsCheckedAt: rows.reduce<number | null>(
      (newest, row) => (newest === null || row.updatedAt > newest ? row.updatedAt : newest),
      null,
    ),
  };
  return body;
}

/** Stores an App for `orgId`, then discovers installations and syncs the
 * webhook URL. Discovery and sync are best-effort: the App is already saved,
 * so a transient failure must not read as a failed connect. */
async function saveApp(providers: Providers, orgId: string, input: GithubAppConfigInput, label: string): Promise<void> {
  const { db, engineCredentials } = providers;
  await saveAppConfig({ credentials: engineCredentials }, orgId, buildAppConfig(input, process.env));
  await invalidateWorkflowSources(db, { orgId });
  try {
    await discoverInstallations(appDeps(providers), orgId);
  } catch (err) {
    console.error(`${label}: post-save discovery failed:`, err);
  }
  // The App can point at a stale public URL, such as a restarted tunnel.
  // `syncAppWebhookUrl` never throws.
  await syncAppWebhookUrl({ credentials: engineCredentials }, orgId, publicUrlFromEnv(process.env));
}

function appCapability(providers: Providers, caller: PluginHttpCaller, request: PluginHttpRequest): GithubAppCapability {
  const { orgId, userId } = caller;
  return {
    status: () => readAppStatus(appDeps(providers), orgId),
    orgName: async () => {
      const [row] = await providers.db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
      return row?.name ?? orgId;
    },
    signSetupState: () => {
      const returnTo = returnOrigin(request);
      return signState(
        "github-app-setup",
        { userId, orgId, nonce: randomBytes(16).toString("hex"), exp: Date.now() + STATE_TTL_MS, ...(returnTo ? { returnTo } : {}) },
        stateKey(providers),
      );
    },
    checkCredential: (credential) => verifyAppCredential({ apiUrl: resolveGithubApiUrl(process.env) }, credential),
    saveApp: (input) => saveApp(providers, orgId, input, "github-app credential"),
    refreshInstallations: async () => {
      try {
        await discoverInstallations(appDeps(providers), orgId);
        return true;
      } catch (err) {
        console.error("github-app refresh: discovery failed:", err);
        return false;
      }
    },
    disconnect: async () => {
      const { db, engineCredentials } = providers;
      // Removes the credential row and installation rows only. A
      // `GITHUB_APP_*` fallback is deployment configuration.
      await engineCredentials.delete({ type: "org", id: orgId }, "github_app");
      await db.transaction(async (tx) => {
        await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for("update");
        await tx.delete(githubInstallations).where(eq(githubInstallations.orgId, orgId));
        await invalidateWorkflowSources(tx, { orgId });
      });
    },
  };
}

/** What a setup state names: the org admin who started setup, their organization, and the return origin. */
interface SetupState {
  userId: string;
  orgId: string;
  returnTo: string;
}

/** Verifies purpose, signature, and expiry. The nonce is not tracked: GitHub's
 * code is single-use, so a replayed state alone cannot complete setup twice. */
function verifySetupState(state: string, key: Buffer): SetupState | null {
  const now = Date.now();
  return verifyState<SetupState>("github-app-setup", state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, orgId, nonce, exp, returnTo } = payload;
    if (typeof userId !== "string" || typeof orgId !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (exp < now) return null;
    // The origin was allow-listed before signing.
    return { userId, orgId, returnTo: typeof returnTo === "string" ? returnTo : "" };
  });
}

/** Setup storage opens only for the admin who signed the state, while they
 * are still an admin of the organization it names. */
function setupCapability(providers: Providers, caller: PluginHttpCaller): GithubSetupCapability {
  return {
    open: async (state) => {
      const verified = verifySetupState(state, stateKey(providers));
      if (!verified) return { status: "invalid" };
      if (verified.userId !== caller.userId) return { status: "refused" };
      if (!(await isOrgAdmin(providers.db, verified.orgId, caller.userId))) return { status: "refused" };
      return {
        status: "open",
        grant: {
          returnTo: verified.returnTo,
          saveApp: (input) => saveApp(providers, verified.orgId, input, "github-app setup"),
        },
      };
    },
  };
}

interface ConnectState {
  userId: string;
  orgId: string;
  returnTo: string;
  postAuthDestination?: GithubPostAuthDestination;
}

function verifyConnectState(state: string, key: Buffer): ConnectState | null {
  const now = Date.now();
  return verifyState<ConnectState>("github-connect", state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, orgId, nonce, exp, returnTo, postAuthDestination } = payload;
    if (typeof userId !== "string" || typeof orgId !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (exp < now) return null;
    return {
      userId,
      orgId,
      returnTo: typeof returnTo === "string" ? returnTo : "",
      ...(postAuthDestination === "integrations" ? { postAuthDestination } : {}),
    };
  });
}

function connectionCapability(
  providers: Providers, caller: PluginHttpCaller, request: PluginHttpRequest,
): GithubConnectionCapability {
  const { userId, orgId } = caller;
  return {
    oauthClientId: async () => (await loadAppConfig(appDeps(providers), orgId))?.oauthClientId ?? null,
    signConnectState: (postAuthDestination) => {
      const returnTo = returnOrigin(request);
      return signState(
        "github-connect",
        {
          userId,
          orgId,
          nonce: randomBytes(16).toString("hex"),
          exp: Date.now() + STATE_TTL_MS,
          ...(returnTo ? { returnTo } : {}),
          ...(postAuthDestination ? { postAuthDestination } : {}),
        },
        stateKey(providers),
      );
    },
    orgStatus: async () => {
      const { db } = providers;
      const config = await loadAppConfig(appDeps(providers), orgId);
      const rows = await db
        .select({ suspended: githubInstallations.suspended })
        .from(githubInstallations)
        .where(eq(githubInstallations.orgId, orgId));
      const [org] = await db
        .select({ allowPersonalInstallations: orgs.allowPersonalInstallations })
        .from(orgs)
        .where(eq(orgs.id, orgId))
        .limit(1);
      const status: GetGithubOrgStatusResponse = {
        configured: config !== null,
        installationCount: rows.length,
        suspendedCount: rows.filter((row) => row.suspended).length,
        ...(config !== null && org?.allowPersonalInstallations === true
          ? { personalInstallUrl: githubAppInstallUrl(process.env, config.appSlug) }
          : {}),
      };
      const projected: GithubOrgStatus = status;
      return projected;
    },
    openCallback: (state) => {
      const verified = verifyConnectState(state, stateKey(providers));
      if (!verified) return { status: "invalid" };
      if (verified.userId !== userId) return { status: "other-user" };
      return {
        status: "open",
        grant: {
          returnTo: verified.returnTo,
          ...(verified.postAuthDestination ? { postAuthDestination: verified.postAuthDestination } : {}),
          oauthClient: async () => {
            const config = await loadAppConfig(appDeps(providers), verified.orgId);
            return config ? { clientId: config.oauthClientId, clientSecret: config.oauthClientSecret } : null;
          },
          saveConnection: async (connection) => {
            // The user's `github` credential is one slot shared with the PAT
            // route (PUT /api/credentials/github). The last write wins.
            await providers.engineCredentials.save({ type: "user", id: userId }, GITHUB_CREDENTIAL_SERVICE, {
              type: "oauth2",
              accessToken: connection.accessToken,
              refreshToken: connection.refreshToken,
              expiresAt: connection.expiresAt,
              metadata: { login: connection.login },
            });
            await refreshCredentialReadiness(providers, { type: "user", id: userId }, GITHUB_CREDENTIAL_SERVICE);
            // Best-effort: the next discovery run catches up.
            try {
              await relinkInstallations(appDeps(providers), verified.orgId);
            } catch (err) {
              console.error("github connect callback: post-save relink failed:", err);
            }
          },
        },
      };
    },
    disconnect: async () => {
      const { db, engineCredentials, contentSync } = providers;
      await engineCredentials.delete({ type: "user", id: userId }, GITHUB_CREDENTIAL_SERVICE);
      // Team references to this row go with it, the same cascade
      // `DELETE /api/credentials/github` runs.
      const revoked = await deleteSharesFrom(db, { userId, service: GITHUB_CREDENTIAL_SERVICE });
      for (const teamId of new Set(revoked)) await contentSync.resyncTeamWorkflowSources(teamId);
      await db
        .update(githubInstallations)
        .set({ linkedUserId: null, updatedAt: Date.now() })
        .where(eq(githubInstallations.linkedUserId, userId));
    },
  };
}

/** The organization that owns the `github_app` credential row. See the single-App caveat above. */
async function findGithubAppOrgId(db: AppQueryable): Promise<string | null> {
  const rows = await db
    .select({ ownerId: credentials.ownerId })
    .from(credentials)
    .where(and(eq(credentials.ownerType, "org"), eq(credentials.service, "github_app")))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}

/** Routing for the `GITHUB_APP_*` fallback: the organization that synced the
 * verified installation, else the oldest organization. Null with no organizations. */
async function resolveEnvFallbackOrgId(db: AppQueryable, installationId: number | null): Promise<string | null> {
  if (installationId !== null) {
    const rows = await db
      .select({ orgId: githubInstallations.orgId })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    if (rows[0]) return rows[0].orgId;
  }
  const [oldest] = await db.select({ id: orgs.id }).from(orgs).orderBy(orgs.createdAt).limit(1);
  return oldest?.id ?? null;
}

function webhookCapability(providers: Providers): GithubWebhookCapability {
  return {
    openDelivery: async () => {
      const { db, engineCredentials } = providers;
      // Prefer an App stored by an organization. With none, use the
      // `GITHUB_APP_*` fallback. If the row disappears after the scan,
      // `loadAppConfig` falls back to the same environment config.
      const ownerOrgId = await findGithubAppOrgId(db);
      const config = ownerOrgId
        ? await loadAppConfig({ credentials: engineCredentials }, ownerOrgId)
        : resolveGithubAppEnvConfig(process.env);
      if (!config) return null;
      return {
        webhookSecret: config.webhookSecret,
        bind: async ({ installationId }) => {
          const orgId = ownerOrgId ?? (await resolveEnvFallbackOrgId(db, installationId));
          return orgId ? deliveryEffects(providers, orgId) : null;
        },
      };
    },
  };
}

function deliveryEffects(providers: Providers, orgId: string): GithubDeliveryEffects {
  const { db } = providers;
  /** Changes one installation row under the organization row lock. */
  const changeInstallation = async (installationId: number, suspended: boolean | null): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for("update");
      const scope = and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId));
      const changed = suspended === null
        ? await tx.delete(githubInstallations).where(scope).returning({ id: githubInstallations.id })
        : await tx.update(githubInstallations)
          .set({ suspended, updatedAt: Date.now() })
          .where(and(scope, eq(githubInstallations.suspended, !suspended)))
          .returning({ id: githubInstallations.id });
      if (changed.length > 0) await invalidateWorkflowSources(tx, { orgId });
    });
  };
  return {
    contentPushed: async (push) => {
      await providers.contentSync.onPush(orgId, push.repoFullName, push.gitRef, push.defaultBranch);
    },
    pullRequestChanged: (change) => setPullRequestState(db, orgId, change.url, change.state),
    installationRemoved: (installationId) => changeInstallation(installationId, null),
    installationSuspended: (installationId, suspended) => changeInstallation(installationId, suspended),
    repositorySelectionChanged: async (installationId, repositorySelection) => {
      await db
        .update(githubInstallations)
        .set({ updatedAt: Date.now(), ...(repositorySelection !== undefined ? { repositorySelection } : {}) })
        .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId)));
    },
    discoverInstallations: async () => {
      await discoverInstallations(appDeps(providers), orgId);
    },
    emit: async (event) => {
      await ingestEvent(
        { db, plugins: providers.plugins, onIngest: providers.eventDispatcher.nudge },
        { orgId, service: "github", event },
      );
    },
    recordUndeliverable: (notice) => writeDropLog(db, {
      orgId, reason: "event_not_ingestable", conversationKey: notice.deliveryId, detail: notice.detail,
    }),
  };
}
