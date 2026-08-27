/**
 * GitHub App setup (GitHub/repo integration plan, Task 5) — builds on the
 * Task 3/4 core service (`services/github-app.ts`): App-manifest creation
 * flow, installations admin, and the public webhook that keeps
 * `github_installations` in sync without a poll loop.
 *
 * There are two ways an org gets an App, and both end at `saveAppConfig`
 * with the same credential row. `POST /manifest` + `GET /setup` create a new
 * App. `POST /credential` connects one that already exists, for an admin
 * whose App name is taken (names are global on GitHub) or whose database was
 * reset. The manifest flow stays the default.
 *
 * Two routers live in this file:
 *
 *   - `githubAppRouter` — admin-gated, mounted at `/api/org/github-app` in
 *     `app.ts` (inside the auth gate, same as `llmProvidersRouter`).
 *   - `githubAppWebhookRouter` — PUBLIC, mounted at `/webhooks/github-app`
 *     BEFORE the auth gate (same reasoning as `routes/channels.ts`'s
 *     `channelsRouter`: the caller is GitHub, not a logged-in Valet user;
 *     verification is HMAC-signature-level, not session auth).
 *
 * ── Manifest flow state (binding to one org, tamper/expiry-checked) ──────
 * `POST /manifest` mints `state = base64url(json).base64url(hmac)` —
 * `{orgId, nonce, exp}` signed with `deriveSecretKey(providers.encryptionKey)`
 * (same passphrase-derivation idiom `providers/node.ts` uses to build the
 * `PgCredentialStore`/`github-app.ts` encryption keys — NOT the same
 * concern, just the same "turn one passphrase into a fixed-size key"
 * helper). `GET /setup` re-derives the same key and rejects a tampered or
 * expired (>15 min) state before ever calling GitHub. `nonce` is not
 * tracked for replay — the state is single-purpose and GitHub's own `code`
 * is already one-time-use, so a replayed state alone can't complete setup
 * twice.
 *
 * ── Owning-org resolution for the public webhook ─────────────────────────
 * GitHub signs webhook deliveries per-App, not per-installation, and the
 * delivery carries no org identifier Valet controls. This deployment is
 * single-App/single-org today (module doc on `services/github-app.ts`), so
 * `findGithubAppOrgId` scans `credentials` for the one `(owner_type='org',
 * service='github_app')` row and uses its `ownerId` — same "honest cheap
 * path" pattern as that file's `loadLinkedUserLoginMap`. A future
 * multi-org deployment needs a real per-App-installation → org lookup
 * (e.g. keyed by GitHub App id in the URL or a signed org hint); this does
 * NOT attempt that and will misroute if more than one org ever configures
 * a `github_app` credential in the same process.
 *
 * When no `github_app` credential row exists anywhere, the webhook falls
 * back to the deployment-wide `GITHUB_APP_*` env config
 * (`resolveGithubAppEnvConfig`): the signature verifies against the env
 * webhook secret, then `resolveEnvFallbackOrgId` routes the delivery by
 * `installation.id` (or to the oldest org). Same single-org caveat.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState as verifySignedState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { resolveReturnOrigin } from "./credential-connect.js";
import { resolveGithubApiUrl, resolveGithubUrl } from "../services/github-env.js";
import {
  buildAppConfig,
  discoverInstallations,
  loadAppConfig,
  loadAppConfigWithSource,
  parsePrivateKeyPem,
  resolveGithubAppEnvConfig,
  saveAppConfig,
  syncAppWebhookUrl,
  verifyAppCredential,
  GITHUB_APP_WEBHOOK_PATH,
  type GithubAppConfig,
  type GithubAppDeps,
} from "../services/github-app.js";
import type { AppQueryable } from "../lib/drizzle.js";
import { ingestEvent } from "../events/ingest.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { findOrgSkillSourcesForPush, parseSkillPushPayload } from "../services/skill-sync-push.js";
import { credentials, githubInstallations, orgs } from "../schema/index.js";
import type {
  GetGithubAppResponse,
  GithubAppInstallationSummary,
  GithubAppManifestWire,
  PostGithubAppCredentialRequest,
  PostGithubAppManifestRequest,
  PostGithubAppManifestResponse,
} from "../wire/types.js";

export const githubAppRouter = new Hono<AppEnv>();
export const githubAppWebhookRouter = new Hono<AppEnv>();

/** Builds the `GithubAppDeps` service-layer dependency bag from request
 * providers. `apiUrl` is left unset — `resolveGithubApiUrl(process.env)`
 * (tests point `GITHUB_API_URL` at `startGithubFixture()`). */
function buildAppDeps(c: Context<AppEnv>): GithubAppDeps {
  const { db, engineCredentials, encryptionKey } = c.var.providers;
  return { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
}

function toInstallationSummary(row: typeof githubInstallations.$inferSelect): GithubAppInstallationSummary {
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

async function buildGetResponse(deps: GithubAppDeps, orgId: string): Promise<GetGithubAppResponse> {
  const loaded = await loadAppConfigWithSource(deps, orgId);
  const rows = await deps.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
  const githubUrl = resolveGithubUrl(process.env);
  return {
    configured: loaded !== null,
    source: loaded?.source,
    app: loaded
      ? {
          appId: loaded.config.appId,
          appSlug: loaded.config.appSlug,
          htmlUrl: loaded.config.htmlUrl,
          installUrl: `${githubUrl}/apps/${loaded.config.appSlug}/installations/new`,
        }
      : undefined,
    installations: rows.map(toInstallationSummary),
    webhook: { mode: publicUrlFromEnv(process.env) ? "public" : "manual" },
    // The newest row's timestamp. `discoverInstallations` writes `updatedAt`
    // on every upsert whether or not the row changed, so this dates the last
    // successful read rather than the last change — which is what the page
    // needs to say how fresh the list is. Reduced here rather than by a SQL
    // `max()`, because the two drivers disagree on what a `max()` over a
    // bigint column returns.
    installationsCheckedAt: rows.reduce<number | null>(
      (newest, row) => (newest === null || row.updatedAt > newest ? row.updatedAt : newest),
      null,
    ),
  };
}

function slugifyOrgName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "org";
}

// ── Manifest-flow state signing ───────────────────────────────────────────
// Sign/verify primitives live in `lib/oauth-state.ts` (shared with Task 6's
// user-connect callback) — this section only owns the manifest-flow's own
// payload shape and expiry check.

interface ManifestState {
  orgId: string;
  nonce: string;
  exp: number;
  /** Origin to send the browser back to after GitHub redirects here.
   * Captured when the state is minted, because at the callback the referer
   * is GitHub, not this app. Empty when the caller is same-origin, which is
   * the deployed shape — the api serves the client, so a relative redirect
   * already lands in the right place. */
  returnTo?: string;
}

/** Verifies signature + expiry. Returns `null` for any tampering, malformed
 * shape, or expired `exp` — never throws. */
function verifyManifestState(
  state: string,
  key: Buffer,
  nowMs: number,
): { orgId: string; returnTo: string } | null {
  return verifySignedState<{ orgId: string; returnTo: string }>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { orgId, exp, returnTo } = payload;
    if (typeof orgId !== "string" || typeof exp !== "number") return null;
    if (exp < nowMs) return null;
    // The origin was allow-listed before signing, so trusting it here is
    // trusting our own signature, not GitHub's query string.
    return { orgId, returnTo: typeof returnTo === "string" ? returnTo : "" };
  });
}

/** Validates GitHub's `POST /app-manifests/{code}/conversions` response
 * shape. `null` on anything malformed — the caller maps that to a 502
 * rather than persisting a half-populated config. */
function parseManifestConversion(payload: unknown): GithubAppConfig | null {
  if (!isRecord(payload)) return null;
  const {
    id,
    slug,
    client_id: clientId,
    client_secret: clientSecret,
    webhook_secret: webhookSecret,
    pem,
    html_url: htmlUrl,
  } = payload;
  if (typeof id !== "number" && typeof id !== "string") return null;
  if (typeof slug !== "string") return null;
  if (typeof clientId !== "string") return null;
  if (typeof clientSecret !== "string") return null;
  // Webhook-less apps (manifest omitted hook_attributes — no public URL,
  // or delivery toggled off) come back with `webhook_secret: null`.
  if (typeof webhookSecret !== "string" && webhookSecret !== null && webhookSecret !== undefined) {
    return null;
  }
  if (typeof pem !== "string") return null;
  if (typeof htmlUrl !== "string") return null;
  return {
    appId: String(id),
    appSlug: slug,
    oauthClientId: clientId,
    htmlUrl,
    oauthClientSecret: clientSecret,
    webhookSecret: webhookSecret ?? "",
    privateKeyPem: pem,
  };
}

// ── Admin routes ───────────────────────────────────────────────────────

githubAppRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const body = await buildGetResponse(buildAppDeps(c), c.var.user.orgId);
  return c.json(body);
});

githubAppRouter.post("/manifest", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  let body: PostGithubAppManifestRequest;
  try {
    body = (await c.req.json()) as PostGithubAppManifestRequest;
  } catch {
    body = {};
  }
  const target = typeof body.target === "string" ? body.target : undefined;

  // Optional permission/event overrides (V1 parity: the advanced picker
  // sends the FULL map, so a deselected permission actually stays off).
  const PERMISSION_LEVELS = new Set(["read", "write", "admin"]);
  let permissionOverride: Record<string, string> | undefined;
  if (body.permissions !== undefined) {
    if (typeof body.permissions !== "object" || body.permissions === null || Array.isArray(body.permissions)) {
      return c.json({ error: "permissions must be an object of {permission: level}" }, 400);
    }
    for (const [key, level] of Object.entries(body.permissions)) {
      if (!/^[a-z_]+$/.test(key) || typeof level !== "string" || !PERMISSION_LEVELS.has(level)) {
        return c.json(
          { error: `invalid permission ${JSON.stringify(key)}=${JSON.stringify(level)} — levels are read/write/admin` },
          400,
        );
      }
    }
    permissionOverride = body.permissions;
  }
  const webhookRequested = body.webhook !== false;
  let eventsOverride: string[] | undefined;
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.some((e) => typeof e !== "string" || !/^[a-z_]+$/.test(e))) {
      return c.json({ error: "events must be an array of snake_case event names" }, 400);
    }
    eventsOverride = body.events;
  }

  const { db, encryptionKey, plugins } = c.var.providers;
  const [orgRow] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const slug = slugifyOrgName(orgRow?.name ?? orgId);

  // Subscribe the App to every event family the github plugin can ingest
  // (TriggerDef ids are "github.{event}"), so installed apps deliver the
  // events the subscription catalog advertises. `ping` is excluded: GitHub
  // sends it on webhook creation regardless of the subscription list.
  const triggerEvents = [
    ...new Set(
      plugins
        .flatMap((p) => p.triggers ?? [])
        .filter((t) => t.service === "github" && t.id !== "github.ping")
        .map((t) => t.id.slice("github.".length)),
    ),
  ];

  const githubUrl = resolveGithubUrl(process.env);
  const url = target?.startsWith("org:")
    ? `${githubUrl}/organizations/${encodeURIComponent(target.slice("org:".length))}/settings/apps/new`
    : `${githubUrl}/settings/apps/new`;

  // Webhook on: GitHub can reach us (public URL) and the caller didn't
  // turn it off — declare a live webhook and subscribe the events.
  // Webhook off/impossible: OMIT hook_attributes entirely. GitHub
  // validates the hook URL's public reachability even with
  // `active: false` ("Hook url is not supported because it isn't
  // reachable over the public Internet (localhost)"), so a placeholder
  // URL gets the whole manifest rejected.
  const publicUrl = publicUrlFromEnv(process.env);
  const apiBase = publicUrl ?? new URL(c.req.url).origin;
  const webhookOn = Boolean(publicUrl) && webhookRequested;

  const manifest: GithubAppManifestWire = {
    name: `valet-${slug}`,
    url: apiBase,
    redirect_url: `${apiBase}/api/org/github-app/setup`,
    callback_urls: [`${apiBase}/api/me/github/callback`],
    ...(webhookOn ? { hook_attributes: { url: `${apiBase}${GITHUB_APP_WEBHOOK_PATH}` } } : {}),
    public: false,
    // Subscribe ONLY to events an App may subscribe to. GitHub delivers
    // the App-lifecycle events (`installation`,
    // `installation_repositories`) to every App on its own, and rejects a
    // manifest that lists them: "Default events unsupported", plus a second
    // rejection because they map to no permission. Listing them here cost
    // us every App creation until it was found by hand.
    default_events: webhookOn ? (eventsOverride ?? triggerEvents) : [],
    // GitHub's manifest schema key is `default_permissions` — a bare
    // `permissions` key makes the app-creation form reject the manifest.
    default_permissions: permissionOverride ?? {
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
      actions: "write",
      checks: "read",
      // The `status` webhook event requires commit-status read access.
      statuses: "read",
    },
  };

  const key = deriveSecretKey(encryptionKey);
  const returnTo = resolveReturnOrigin(c.req.url, c.req.header("referer"), process.env);
  const statePayload: ManifestState = {
    orgId,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
    ...(returnTo ? { returnTo } : {}),
  };
  const state = signState(statePayload, key);

  const responseBody: PostGithubAppManifestResponse = { url, manifest, state };
  return c.json(responseBody);
});

githubAppRouter.get("/setup", async (c) => {
  // No `requireOrgAdmin` gate here — this is GitHub's browser-redirect
  // callback, not an API call from an authenticated Valet session. The
  // signed `state` (bound to the admin who started the flow, 15-minute
  // expiry) is the security boundary instead.
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const { db, engineCredentials, encryptionKey } = c.var.providers;
  const key = deriveSecretKey(encryptionKey);
  const verified = verifyManifestState(state, key, Date.now());
  if (!verified) return c.json({ error: "invalid or expired state" }, 400);

  const apiUrl = resolveGithubApiUrl(process.env);
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch (err) {
    console.error("github-app setup: manifest conversion request failed:", err);
    return c.json({ error: "failed to reach GitHub" }, 502);
  }
  if (!res.ok) {
    // 5xx is an upstream outage (502, retryable). 4xx means the code is
    // invalid/expired/already-consumed — GitHub's state disagrees with
    // what we expected to exchange, which is a conflict (409), not a
    // transport failure.
    if (res.status >= 500) return c.json({ error: `GitHub returned ${res.status}` }, 502);
    return c.json({ error: `GitHub rejected the manifest code (status ${res.status})` }, 409);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return c.json({ error: "malformed response from GitHub" }, 502);
  }
  const config = parseManifestConversion(payload);
  if (!config) return c.json({ error: "malformed response from GitHub" }, 502);

  await saveAppConfig({ credentials: engineCredentials }, verified.orgId, config);

  // Best-effort: a transient discovery failure shouldn't strand the admin
  // on an error page after the app itself saved successfully — `POST
  // /refresh` (or the next webhook delivery) will catch up.
  try {
    await discoverInstallations({ db, credentials: engineCredentials, key }, verified.orgId);
  } catch (err) {
    console.error("github-app setup: post-save discovery failed:", err);
  }

  // The app was created with the public URL this instance had when the
  // manifest was built. That URL can already be stale (an ephemeral tunnel
  // restarts between the manifest POST and this callback), so assert the
  // current one. `syncAppWebhookUrl` never throws — the admin must reach the
  // success page even when GitHub refuses the update.
  await syncAppWebhookUrl({ credentials: engineCredentials }, verified.orgId, publicUrlFromEnv(process.env));

  return c.redirect(`${verified.returnTo}/settings/organization/github?setup=ok`, 302);
});

/** Reads a string field, trimmed. `""` for anything absent or not a string —
 * the caller decides which fields that makes missing. Trimming is safe for
 * the private key: a PEM is unchanged by it, and base64 delivery often gains
 * a trailing newline. */
function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

function readCredentialRequest(body: Record<string, unknown>): PostGithubAppCredentialRequest {
  return {
    appId: stringField(body, "appId"),
    privateKey: stringField(body, "privateKey"),
    appSlug: stringField(body, "appSlug"),
    oauthClientId: stringField(body, "oauthClientId"),
    oauthClientSecret: stringField(body, "oauthClientSecret"),
    webhookSecret: stringField(body, "webhookSecret"),
  };
}

const SEND_JSON_BODY = "Send a JSON body with the app id and the private key.";

/**
 * The second setup path: connect a GitHub App that already exists.
 *
 * An App name is global on GitHub, so an admin who already made an App — or
 * whose database was reset — cannot use `POST /manifest` again. That attempt
 * fails on GitHub's own page, where this app never sees the error and cannot
 * explain it. Here the admin supplies the credential instead.
 *
 * The credential is checked against GitHub BEFORE it is stored (`GET /app`,
 * see `verifyAppCredential`). A wrong app id or private key is refused at the
 * paste, with a message naming the fix, rather than at the first tool call an
 * hour later. The check also reports the app's slug, page URL and OAuth
 * client id, so the admin only has to supply what GitHub keeps to itself.
 *
 * The save overwrites an existing credential row, the same as `GET /setup`
 * does. That is what rotating an app's private key looks like, and the form
 * that drives this route is only offered while the org has no app at all.
 *
 * The response is `GetGithubAppResponse` — the same body `GET /` returns, so
 * the client re-renders from one payload, and no secret is echoed back.
 */
githubAppRouter.post("/credential", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: SEND_JSON_BODY }, 400);
  }
  if (!isRecord(parsed)) return c.json({ error: SEND_JSON_BODY }, 400);
  const body = readCredentialRequest(parsed);

  const missing = [...(body.appId ? [] : ["the app id"]), ...(body.privateKey ? [] : ["the private key"])];
  if (missing.length > 0) {
    return c.json(
      {
        error: `Enter ${missing.join(" and ")}. The app's settings page on GitHub shows the app id, and generates a private key.`,
      },
      400,
    );
  }

  const privateKeyPem = parsePrivateKeyPem(body.privateKey);
  if (!privateKeyPem) {
    return c.json(
      {
        error:
          "The private key is not a PEM. Paste the whole file GitHub downloaded, including the BEGIN and END lines.",
      },
      400,
    );
  }

  const check = await verifyAppCredential(
    { apiUrl: resolveGithubApiUrl(process.env) },
    { appId: body.appId, privateKeyPem },
  );
  if (!check.ok) return c.json({ error: check.error }, 400);

  // GitHub is authoritative for everything it reports: it answered for this
  // exact key, so its slug beats a mistyped one. The supplied values are the
  // fallback for the fields GitHub marks optional.
  const appSlug = check.app.appSlug ?? body.appSlug ?? "";
  if (!appSlug) {
    return c.json(
      {
        error:
          "GitHub did not report the app's slug. Enter it yourself. The slug is the last part of the app's URL on GitHub.",
      },
      400,
    );
  }

  const orgId = c.var.user.orgId;
  const deps = buildAppDeps(c);
  const config = buildAppConfig(
    {
      appId: check.app.appId,
      appSlug,
      oauthClientId: check.app.oauthClientId ?? body.oauthClientId ?? "",
      htmlUrl: check.app.htmlUrl,
      privateKeyPem,
      oauthClientSecret: body.oauthClientSecret,
      webhookSecret: body.webhookSecret,
    },
    process.env,
  );
  await saveAppConfig({ credentials: c.var.providers.engineCredentials }, orgId, config);

  // Best-effort, same as `GET /setup`: the credential is already stored, so a
  // transient discovery failure must not read as a failed connect. `POST
  // /refresh` catches up.
  try {
    await discoverInstallations(deps, orgId);
  } catch (err) {
    console.error("github-app credential: post-save discovery failed:", err);
  }

  // The stored key makes this instance the app's owner (see
  // `syncAppWebhookUrl`), so assert this instance's webhook URL — otherwise
  // events keep going to wherever the app pointed before, and nothing says
  // so. Never throws.
  await syncAppWebhookUrl({ credentials: c.var.providers.engineCredentials }, orgId, publicUrlFromEnv(process.env));

  return c.json(await buildGetResponse(deps, orgId));
});

githubAppRouter.post("/refresh", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  const deps = buildAppDeps(c);
  try {
    await discoverInstallations(deps, orgId);
  } catch (err) {
    console.error("github-app refresh: discovery failed:", err);
    return c.json({ error: "failed to refresh installations from GitHub" }, 502);
  }
  return c.json(await buildGetResponse(deps, orgId));
});

githubAppRouter.delete("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  const { db, engineCredentials } = c.var.providers;
  // Deliberately no refusal here even if sessions/workflows currently
  // resolve GitHub auth through this app: resolution degrades gracefully
  // (`resolveGitHubToken` throws a `GitHubAuthError` naming the gap, same
  // as "never configured") rather than needing this route to first prove
  // nothing depends on it.
  // This only removes the org's credential row + installation rows. The
  // `GITHUB_APP_*` env fallback (if set) is deployment config — GET keeps
  // reporting `configured: true, source: "environment"` until the operator
  // unsets the variables.
  await engineCredentials.delete({ type: "org", id: orgId }, "github_app");
  await db.delete(githubInstallations).where(eq(githubInstallations.orgId, orgId));
  return c.body(null, 204);
});

// ── Public webhook ─────────────────────────────────────────────────────

/** GitHub webhook payloads are small JSON; 1 MiB matches the cap
 * `routes/channels.ts` uses for the same reason (bound what an
 * unauthenticated caller can force us to buffer/parse). */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

const SIG_FAILURE_LOG_INTERVAL_MS = 60_000;
let lastSigFailureLogAt = 0;

/** Throttled `console.warn` for signature failures — mirrors the
 * telegram/channel webhook precedent of not letting a scan/replay flood
 * logs at request volume. */
function logSigFailureThrottled(message: string): void {
  const now = Date.now();
  if (now - lastSigFailureLogAt < SIG_FAILURE_LOG_INTERVAL_MS) return;
  lastSigFailureLogAt = now;
  console.warn(message);
}

/** Single-org "which org owns the `github_app` credential" scan — see the
 * module doc comment for the multi-org caveat. */
async function findGithubAppOrgId(db: AppQueryable): Promise<string | null> {
  const rows = await db
    .select({ ownerId: credentials.ownerId })
    .from(credentials)
    .where(and(eq(credentials.ownerType, "org"), eq(credentials.service, "github_app")))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}

/** Org routing for a delivery verified against the `GITHUB_APP_*` env
 * fallback (no `github_app` credential row anywhere). The delivery's
 * `installation.id` routes to the org that already synced that
 * installation; otherwise the deployment's oldest org takes it — same
 * single-org assumption (and the same multi-org caveat) as
 * `findGithubAppOrgId`. `null` when the deployment has no orgs at all. */
async function resolveEnvFallbackOrgId(db: AppQueryable, payload: unknown): Promise<string | null> {
  if (isRecord(payload) && isRecord(payload.installation) && typeof payload.installation.id === "number") {
    const rows = await db
      .select({ orgId: githubInstallations.orgId })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, payload.installation.id))
      .limit(1);
    if (rows[0]) return rows[0].orgId;
  }
  const [oldest] = await db.select({ id: orgs.id }).from(orgs).orderBy(orgs.createdAt).limit(1);
  return oldest?.id ?? null;
}

function verifyWebhookSignature(rawBody: Uint8Array, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  // A webhook-less app stores an empty secret — nothing should ever
  // deliver, and an empty HMAC key must never verify an attacker's guess.
  if (secret.length === 0) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex")}`;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `installation` event: `created` re-syncs via `discoverInstallations`
 * (needs the GitHub API round-trip anyway to set `linkedUserId` correctly);
 * `deleted`/`suspend`/`unsuspend` flip/remove the row directly from the
 * payload — no network call needed, and cheaper/less flaky under webhook
 * delivery's short timeout budget. Other actions (e.g.
 * `new_permissions_accepted`) are no-ops. */
async function handleInstallationEvent(deps: GithubAppDeps, orgId: string, payload: unknown): Promise<void> {
  if (!isRecord(payload)) return;
  const { action, installation } = payload;
  if (!isRecord(installation)) return;
  const installationId = installation.id;
  if (typeof installationId !== "number") return;

  if (action === "deleted") {
    await deps.db
      .delete(githubInstallations)
      .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId)));
    return;
  }

  if (action === "suspend" || action === "unsuspend") {
    await deps.db
      .update(githubInstallations)
      .set({ suspended: action === "suspend", updatedAt: Date.now() })
      .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId)));
    return;
  }

  if (action === "created") {
    try {
      await discoverInstallations(deps, orgId);
    } catch (err) {
      console.error("github-app webhook: discovery after installation.created failed:", err);
    }
  }
}

/** `installation_repositories` event: repo selection may have changed
 * (`all` <-> `selected`, or which repos are in scope) — re-derive
 * `repositorySelection` from the payload when present and always touch
 * `updatedAt`. No API round-trip: the payload already carries the current
 * `repository_selection`. */
async function handleInstallationRepositoriesEvent(db: AppQueryable, orgId: string, payload: unknown): Promise<void> {
  if (!isRecord(payload)) return;
  const installation = payload.installation;
  if (!isRecord(installation)) return;
  const installationId = installation.id;
  if (typeof installationId !== "number") return;

  const repositorySelection = typeof payload.repository_selection === "string" ? payload.repository_selection : undefined;
  await db
    .update(githubInstallations)
    .set({ updatedAt: Date.now(), ...(repositorySelection !== undefined ? { repositorySelection } : {}) })
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId)));
}

githubAppWebhookRouter.post("/", async (c) => {
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }

  const { db, engineCredentials, encryptionKey } = c.var.providers;
  // Prefer a credential-row app; with none anywhere, fall back to the
  // `GITHUB_APP_*` env config. The webhook secret is App-level either way,
  // so signature verification never needs the org first. In the orgId
  // branch, `loadAppConfig` reads `process.env` if the row vanished
  // between the scan and here — the same deployment-wide fallback the
  // null branch uses, so the race changes nothing.
  let orgId = await findGithubAppOrgId(db);
  const config = orgId
    ? await loadAppConfig({ credentials: engineCredentials }, orgId)
    : resolveGithubAppEnvConfig(process.env);
  if (!config) return c.body(null, 204); // no app configured anywhere in this deployment

  const sigHeader = c.req.header("x-hub-signature-256");
  if (!verifyWebhookSignature(rawBody, sigHeader, config.webhookSecret)) {
    logSigFailureThrottled("github-app webhook: signature verification failed");
    return c.json({ error: "signature verification failed" }, 403);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  if (!orgId) {
    orgId = await resolveEnvFallbackOrgId(db, payload);
    if (!orgId) return c.body(null, 204); // env app configured but no orgs exist yet
  }

  const event = c.req.header("x-github-event");
  const deps: GithubAppDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
  // Org skill sources sync on `push`. Personal and team sources stay on
  // the poll — they often have no App installation. `syncOnce` is the
  // same path the sweep and the Sync button use.
  if (event === "push") {
    const push = parseSkillPushPayload(payload);
    if (push) {
      const sources = await findOrgSkillSourcesForPush(db, orgId, push);
      for (const source of sources) {
        await c.var.providers.skillSync.syncOnce(source.id).catch((err) => {
          console.error(`skill sync ${source.id} (github push):`, err);
        });
      }
    }
  }
  if (event === "installation") {
    await handleInstallationEvent(deps, orgId, payload);
  } else if (event === "installation_repositories") {
    await handleInstallationRepositoriesEvent(db, orgId, payload);
  } else if (event && event !== "ping") {
    // Forward every other event family into the generic event pipeline.
    // Signature + org are already verified above; build the VerifiedEvent
    // directly instead of re-running TriggerDef.verify. NOTE this means two
    // ingest paths with different invariants: any check added to the github
    // TriggerDef.verify (payload sanity, dedupe policy) applies only to the
    // generic `/webhooks/events/:service` ingress, not here — folding this
    // path into the generic ingress (e.g. a `resolveInstall` hook on
    // TriggerDef) is the recorded follow-up in the event-system spec.
    const deliveryId = c.req.header("x-github-delivery");
    const def = c.var.providers.plugins
      .flatMap((p) => p.triggers ?? [])
      .find((t) => t.service === "github" && t.id === `github.${event}`);
    if (def && deliveryId) {
      await ingestEvent(
        { db, plugins: c.var.providers.plugins, onIngest: c.var.providers.eventDispatcher.nudge },
        { orgId, service: "github", event: def.toEvent({ eventType: event, deliveryId, payload }) },
      );
    } else {
      // GitHub is sending an event this deployment can't ingest (no matching
      // TriggerDef, or a missing delivery id). Drop-log instead of a silent
      // 204 so ops can see the gap.
      await writeDropLog(db, {
        orgId,
        reason: "event_not_ingestable",
        conversationKey: deliveryId ?? undefined,
        detail: def
          ? `github event ${event}: missing x-github-delivery header`
          : `github event ${event}: no registered TriggerDef (github.${event})`,
      });
    }
  }
  return c.body(null, 204);
});
