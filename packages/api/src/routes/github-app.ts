/**
 * GitHub App setup (GitHub/repo integration plan, Task 5) — builds on the
 * Task 3/4 core service (`services/github-app.ts`): App-manifest creation
 * flow, installations admin, and the public webhook that keeps
 * `github_installations` in sync without a poll loop.
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
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "./_org-admin.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState as verifySignedState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { resolveGithubApiUrl, resolveGithubUrl } from "../services/github-env.js";
import {
  discoverInstallations,
  loadAppConfig,
  saveAppConfig,
  type GithubAppConfig,
  type GithubAppDeps,
} from "../services/github-app.js";
import type { AppQueryable } from "../lib/drizzle.js";
import { ingestEvent } from "../events/ingest.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { credentials, githubInstallations, orgs } from "../schema/index.js";
import type {
  GetGithubAppResponse,
  GithubAppInstallationSummary,
  GithubAppManifestWire,
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
  const config = await loadAppConfig(deps, orgId);
  const rows = await deps.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
  const githubUrl = resolveGithubUrl(process.env);
  return {
    configured: config !== null,
    app: config
      ? {
          appId: config.appId,
          appSlug: config.appSlug,
          htmlUrl: config.htmlUrl,
          installUrl: `${githubUrl}/apps/${config.appSlug}/installations/new`,
        }
      : undefined,
    installations: rows.map(toInstallationSummary),
    webhook: { mode: publicUrlFromEnv(process.env) ? "public" : "manual" },
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
}

/** Verifies signature + expiry. Returns `null` for any tampering, malformed
 * shape, or expired `exp` — never throws. */
function verifyManifestState(state: string, key: Buffer, nowMs: number): { orgId: string } | null {
  return verifySignedState<{ orgId: string }>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { orgId, exp } = payload;
    if (typeof orgId !== "string" || typeof exp !== "number") return null;
    if (exp < nowMs) return null;
    return { orgId };
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
  if (typeof webhookSecret !== "string") return null;
  if (typeof pem !== "string") return null;
  if (typeof htmlUrl !== "string") return null;
  return {
    appId: String(id),
    appSlug: slug,
    oauthClientId: clientId,
    htmlUrl,
    oauthClientSecret: clientSecret,
    webhookSecret,
    privateKeyPem: pem,
  };
}

// ── Admin routes ───────────────────────────────────────────────────────

githubAppRouter.get("/", async (c) => {
  const gate = requirePermission("infra:manage")(c);
  if (gate) return gate;
  const body = await buildGetResponse(buildAppDeps(c), c.var.user.orgId);
  return c.json(body);
});

githubAppRouter.post("/manifest", async (c) => {
  const gate = requirePermission("infra:manage")(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  let body: PostGithubAppManifestRequest;
  try {
    body = (await c.req.json()) as PostGithubAppManifestRequest;
  } catch {
    body = {};
  }
  const target = typeof body.target === "string" ? body.target : undefined;

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

  // Public mode: GitHub can reach us, so the manifest both declares a live
  // webhook (default_events non-empty, hook_attributes.url reachable, no
  // `active` override needed — GitHub defaults a present hook to active).
  // Manual mode: GitHub's manifest schema still requires SOME
  // `hook_attributes.url` whenever the field is present, even though
  // there's nowhere reachable to put it yet — send the (unreachable) API
  // base as a placeholder and set `active: false` so GitHub never attempts
  // delivery against it; the org can wire a real webhook manually later.
  const publicUrl = publicUrlFromEnv(process.env);
  const apiBase = publicUrl ?? new URL(c.req.url).origin;
  const webhookUrl = `${apiBase}/webhooks/github-app`;

  const manifest: GithubAppManifestWire = {
    name: `valet-${slug}`,
    url: apiBase,
    redirect_url: `${apiBase}/api/org/github-app/setup`,
    hook_attributes: publicUrl ? { url: webhookUrl } : { url: webhookUrl, active: false },
    public: false,
    default_events: publicUrl ? ["installation", "installation_repositories", ...triggerEvents] : [],
    permissions: {
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
  const statePayload: ManifestState = { orgId, nonce: randomBytes(16).toString("hex"), exp: Date.now() + STATE_TTL_MS };
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

  return c.redirect("/settings/organization/github?setup=ok", 302);
});

githubAppRouter.post("/refresh", async (c) => {
  const gate = requirePermission("infra:manage")(c);
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
  const gate = requirePermission("infra:manage")(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  const { db, engineCredentials } = c.var.providers;
  // Deliberately no refusal here even if sessions/workflows currently
  // resolve GitHub auth through this app: resolution degrades gracefully
  // (`resolveGitHubToken` throws a `GitHubAuthError` naming the gap, same
  // as "never configured") rather than needing this route to first prove
  // nothing depends on it.
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

function verifyWebhookSignature(rawBody: Uint8Array, header: string | undefined, secret: string): boolean {
  if (!header) return false;
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
  const orgId = await findGithubAppOrgId(db);
  if (!orgId) return c.body(null, 204); // no app configured anywhere in this deployment

  const config = await loadAppConfig({ credentials: engineCredentials }, orgId);
  if (!config) return c.body(null, 204); // credential row vanished between the scan and here

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

  const event = c.req.header("x-github-event");
  const deps: GithubAppDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
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
