/**
 * GitHub App setup routes. There are two ways an organization gets an App,
 * and both end at `saveApp` with the same credential. `POST /app/manifest`
 * plus `GET /app/setup` create a new App. `POST /app/credential` connects an
 * App that already exists, for an admin whose App name is taken (names are
 * global on GitHub) or whose database was reset.
 *
 * The manifest names the legacy setup, callback, and webhook URLs. Existing
 * Apps store those URLs, and the host keeps them as aliases.
 */
import type { PluginHttpRequest } from "@valet/engine";
import type { GithubAppCapability, GithubAppConfigInput, GithubEndpoints, GithubSetupCapability } from "./capabilities.js";
import { isRecord, json, noContent, queryParam, readJson, redirect } from "./respond.js";

/** Legacy URLs that existing Apps store. */
export const GITHUB_APP_SETUP_PATH = "/api/org/github-app/setup";
export const GITHUB_CONNECT_CALLBACK_PATH = "/api/me/github/callback";
export const GITHUB_APP_WEBHOOK_PATH = "/webhooks/github-app";

export interface GithubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: string[];
  hook_attributes?: { url: string };
  public: boolean;
  default_events: string[];
  default_permissions: Record<string, string>;
}

const PERMISSION_LEVELS = new Set(["read", "write", "admin"]);

const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  checks: "read",
  // The `status` webhook event requires commit-status read access.
  statuses: "read",
};

function slugifyOrgName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "org";
}

export async function appStatus(app: GithubAppCapability): Promise<Response> {
  return json(await app.status());
}

export async function appManifest(
  request: PluginHttpRequest,
  app: GithubAppCapability,
  endpoints: GithubEndpoints,
  triggerIds: readonly string[],
): Promise<Response> {
  const parsed = readJson(request);
  const body = isRecord(parsed) ? parsed : {};
  const target = typeof body.target === "string" ? body.target : undefined;

  // The advanced picker sends the FULL map, so a deselected permission stays off.
  let permissionOverride: Record<string, string> | undefined;
  if (body.permissions !== undefined) {
    if (!isRecord(body.permissions) || Array.isArray(body.permissions)) {
      return json({ error: "permissions must be an object of {permission: level}" }, 400);
    }
    const permissions: Record<string, string> = {};
    for (const [key, level] of Object.entries(body.permissions)) {
      if (!/^[a-z_]+$/.test(key) || typeof level !== "string" || !PERMISSION_LEVELS.has(level)) {
        return json(
          { error: `invalid permission ${JSON.stringify(key)}=${JSON.stringify(level)} — levels are read/write/admin` },
          400,
        );
      }
      permissions[key] = level;
    }
    permissionOverride = permissions;
  }
  const webhookRequested = body.webhook !== false;
  let eventsOverride: string[] | undefined;
  if (body.events !== undefined) {
    const events = body.events;
    if (!Array.isArray(events) || events.some((event) => typeof event !== "string" || !/^[a-z_]+$/.test(event))) {
      return json({ error: "events must be an array of snake_case event names" }, 400);
    }
    eventsOverride = events.filter((event): event is string => typeof event === "string");
  }

  const slug = slugifyOrgName(await app.orgName());

  // Subscribe the App to every event family a loaded trigger can ingest
  // (trigger IDs are "github.{event}"). GitHub sends `ping` on webhook
  // creation regardless of the subscription list.
  const triggerEvents = [
    ...new Set(triggerIds.filter((id) => id !== "github.ping").map((id) => id.slice("github.".length))),
  ];

  const url = target?.startsWith("org:")
    ? `${endpoints.githubUrl}/organizations/${encodeURIComponent(target.slice("org:".length))}/settings/apps/new`
    : `${endpoints.githubUrl}/settings/apps/new`;

  // GitHub validates the hook URL's public reachability even with
  // `active: false`, so a placeholder URL gets the whole manifest rejected.
  // Without a public URL, or when the caller turns delivery off, omit
  // hook_attributes entirely.
  const apiBase = endpoints.publicUrl ?? new URL(request.url).origin;
  const webhookOn = Boolean(endpoints.publicUrl) && webhookRequested;

  const manifest: GithubAppManifest = {
    name: `valet-${slug}`,
    url: apiBase,
    redirect_url: `${apiBase}${GITHUB_APP_SETUP_PATH}`,
    callback_urls: [`${apiBase}${GITHUB_CONNECT_CALLBACK_PATH}`],
    ...(webhookOn ? { hook_attributes: { url: `${apiBase}${GITHUB_APP_WEBHOOK_PATH}` } } : {}),
    // Public, as the legacy stack made it, so members can install the App on
    // their personal accounts. A private App installs only on its owner. The
    // host lets a personal installation serve only the member it is bound to
    // (`services/github-app.ts`, "Who may use an installation").
    public: true,
    // GitHub delivers `installation` and `installation_repositories` to
    // every App, and rejects a manifest that lists them.
    default_events: webhookOn ? (eventsOverride ?? triggerEvents) : [],
    // The manifest schema key is `default_permissions`. A bare `permissions`
    // key makes the App creation form reject the manifest.
    default_permissions: permissionOverride ?? DEFAULT_PERMISSIONS,
  };

  return json({ url, manifest, state: app.signSetupState() });
}

const SETUP_REFUSED =
  "Only the org admin who started this GitHub App setup can finish it. Ask an org admin to start the setup again.";

/** Validates GitHub's `POST /app-manifests/{code}/conversions` reply. Null
 * when malformed, so the caller never stores a half-populated config. */
export function parseManifestConversion(payload: unknown): GithubAppConfigInput | null {
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
  // An App created without hook_attributes returns `webhook_secret: null`.
  if (typeof webhookSecret !== "string" && webhookSecret !== null && webhookSecret !== undefined) return null;
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

/**
 * GitHub's browser redirect after App creation. The host requires a signed-in
 * user. The signed state names the organization and the org admin who started
 * setup, and is valid for 15 minutes. The host opens it only for that admin
 * while they are still an org admin, before this route calls GitHub.
 */
export async function appSetup(
  request: PluginHttpRequest,
  setup: GithubSetupCapability,
  endpoints: GithubEndpoints,
): Promise<Response> {
  const code = queryParam(request, "code");
  const state = queryParam(request, "state");
  if (!code || !state) return json({ error: "missing code or state" }, 400);

  const opening = await setup.open(state);
  if (opening.status === "invalid") return json({ error: "invalid or expired state" }, 400);
  if (opening.status === "refused") return json({ error: SETUP_REFUSED }, 403);
  const { grant } = opening;

  let res: Response;
  try {
    res = await fetch(`${endpoints.githubApiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch (err) {
    console.error("github-app setup: manifest conversion request failed:", err);
    return json({ error: "failed to reach GitHub" }, 502);
  }
  if (!res.ok) {
    // 5xx is an upstream outage. 4xx means the code is invalid, expired, or
    // already used, which conflicts with the expected exchange.
    if (res.status >= 500) return json({ error: `GitHub returned ${res.status}` }, 502);
    return json({ error: `GitHub rejected the manifest code (status ${res.status})` }, 409);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return json({ error: "malformed response from GitHub" }, 502);
  }
  const config = parseManifestConversion(payload);
  if (!config) return json({ error: "malformed response from GitHub" }, 502);

  await grant.saveApp(config);
  return redirect(`${grant.returnTo}/settings/organization/github?setup=ok`);
}

/** Accepts a raw PEM or a base64-encoded PEM. Null for anything else. */
export function parsePrivateKeyPem(raw: string): string | null {
  if (raw.trimStart().startsWith("-----BEGIN")) return raw;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  return decoded.trimStart().startsWith("-----BEGIN") ? decoded : null;
}

/** A trimmed string field, or `""` when absent. Trimming leaves a PEM intact. */
function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

const SEND_JSON_BODY = "Send a JSON body with the app id and the private key.";

/**
 * Connects a GitHub App that already exists. GitHub checks the credential
 * before the host stores it, so a wrong App ID or key fails at the paste.
 * The reply is the same body `GET /app` returns, with no secret echoed.
 */
export async function appCredential(request: PluginHttpRequest, app: GithubAppCapability): Promise<Response> {
  const parsed = readJson(request);
  if (!isRecord(parsed)) return json({ error: SEND_JSON_BODY }, 400);
  const body = {
    appId: stringField(parsed, "appId"),
    privateKey: stringField(parsed, "privateKey"),
    appSlug: stringField(parsed, "appSlug"),
    oauthClientId: stringField(parsed, "oauthClientId"),
    oauthClientSecret: stringField(parsed, "oauthClientSecret"),
    webhookSecret: stringField(parsed, "webhookSecret"),
  };

  const missing = [...(body.appId ? [] : ["the app id"]), ...(body.privateKey ? [] : ["the private key"])];
  if (missing.length > 0) {
    return json(
      { error: `Enter ${missing.join(" and ")}. The app's settings page on GitHub shows the app id, and generates a private key.` },
      400,
    );
  }

  const privateKeyPem = parsePrivateKeyPem(body.privateKey);
  if (!privateKeyPem) {
    return json(
      { error: "The private key is not a PEM. Paste the whole file GitHub downloaded, including the BEGIN and END lines." },
      400,
    );
  }

  const check = await app.checkCredential({ appId: body.appId, privateKeyPem });
  if (!check.ok) return json({ error: check.error }, 400);

  // GitHub answered for this exact key, so its values win. The supplied
  // values fill the fields GitHub marks optional.
  const appSlug = check.app.appSlug ?? body.appSlug ?? "";
  if (!appSlug) {
    return json(
      { error: "GitHub did not report the app's slug. Enter it yourself. The slug is the last part of the app's URL on GitHub." },
      400,
    );
  }

  await app.saveApp({
    appId: check.app.appId,
    appSlug,
    oauthClientId: check.app.oauthClientId ?? body.oauthClientId ?? "",
    htmlUrl: check.app.htmlUrl,
    privateKeyPem,
    oauthClientSecret: body.oauthClientSecret,
    webhookSecret: body.webhookSecret,
  });
  return json(await app.status());
}

export async function appRefresh(app: GithubAppCapability): Promise<Response> {
  if (!(await app.refreshInstallations())) {
    return json({ error: "failed to refresh installations from GitHub" }, 502);
  }
  return json(await app.status());
}

/**
 * Removes the organization's App credential and installation rows. Sessions
 * that resolve GitHub access through the App fail with a named error, the
 * same as an App that was never configured. A `GITHUB_APP_*` fallback stays
 * configured until the operator unsets it.
 */
export async function appDisconnect(app: GithubAppCapability): Promise<Response> {
  await app.disconnect();
  return noContent();
}

/**
 * Approves (`approved: true`) or revokes another GitHub organization's
 * installation for every member. The App is public, so any organization
 * can install it, and such an installation serves nobody until an org admin
 * approves it. Answers with the App status, as refresh does.
 */
export async function appInstallationApproval(
  request: PluginHttpRequest,
  app: GithubAppCapability,
  approved: boolean,
): Promise<Response> {
  const raw = request.params.installationId ?? "";
  if (!/^[0-9]{1,18}$/.test(raw)) {
    return json({ error: "The installation id must be a number. Copy it from the installations list." }, 400);
  }
  const installationId = Number(raw);
  const result = await app.setInstallationApproval(installationId, approved);
  if (result === "not_found") {
    return json({ error: `No installation ${installationId}. Choose Refresh installations, then try again.` }, 404);
  }
  if (result === "personal") {
    return json(
      { error: "A personal installation serves only the member who owns that GitHub account. It cannot serve the whole organization." },
      400,
    );
  }
  return json(await app.status());
}
