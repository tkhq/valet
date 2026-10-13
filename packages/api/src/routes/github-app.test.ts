import { githubAccountId } from "../test-helpers/github-fixture.js";
/**
 * `/api/org/github-app` admin routes + PUBLIC `/webhooks/github-app` sync
 * (GitHub/repo integration plan, Task 5). Route-level: real Hono app via
 * `bootTestApi`, real HTTP requests, a fake GitHub API server
 * (`startGithubFixture`) subbed in via `GITHUB_API_URL` for the duration of
 * tests that need `discoverInstallations` to actually call out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { eventDropLog, eventDeliveries, events, eventSubscriptions, githubInstallations, contentSources, orgMembers, orgs, users } from "../schema/index.js";
import { saveVerifiedGithubIdentity, mintInstallationToken, discoverInstallations } from "../services/github-app.js";
import { deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { createContentSource } from "../services/content-sources.js";
import type { GetGithubAppResponse, PostGithubAppManifestResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

const { privateKey: TEST_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;
const prevGithubApiUrl = process.env.GITHUB_API_URL;
const prevValetPublicUrl = process.env.VALET_PUBLIC_URL;

/** `GITHUB_APP_*` fallback fixture — `setEnvApp()` applies it to
 * `process.env`; the shared `afterEach` restores the previous values. */
const ENV_APP = {
  GITHUB_APP_ID: "777",
  GITHUB_APP_SLUG: "valet-env",
  GITHUB_APP_CLIENT_ID: "Iv1.envclient",
  GITHUB_APP_CLIENT_SECRET: "env-oauth-secret",
  GITHUB_APP_WEBHOOK_SECRET: "env-hook-secret",
  GITHUB_APP_PRIVATE_KEY: TEST_PEM,
};
const prevEnvApp = Object.fromEntries(Object.keys(ENV_APP).map((k) => [k, process.env[k]]));

function setEnvApp(): void {
  Object.assign(process.env, ENV_APP);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
  if (prevValetPublicUrl === undefined) delete process.env.VALET_PUBLIC_URL;
  else process.env.VALET_PUBLIC_URL = prevValetPublicUrl;
  for (const [name, prev] of Object.entries(prevEnvApp)) {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
});

function useFixture(overrides: Parameters<typeof startGithubFixture>[0] = {}): GithubFixture {
  fixture = startGithubFixture(overrides);
  process.env.GITHUB_API_URL = fixture.url;
  return fixture;
}

async function fetchManifestState(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/org/github-app/manifest`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as PostGithubAppManifestResponse;
  return body.state;
}

/** Drives the full manifest → setup exchange with a REAL RSA PEM (so any
 * discovery triggered along the way — `GET /setup`'s own best-effort call,
 * or a later `installation.created` webhook — can actually mint an App JWT
 * instead of failing on an unparsable key). Returns the webhook secret the
 * fixture handed back, for signing webhook test requests. */
async function setupConfiguredOrg(
  baseUrl: string,
  overrides: Parameters<typeof startGithubFixture>[0] = {},
): Promise<{ webhookSecret: string; fixture: GithubFixture }> {
  const f = useFixture({
    listInstallations: () => ({ body: [] }),
    convertManifest: () => ({
      body: {
        id: 42,
        slug: "valet-acme",
        name: "Valet Acme",
        client_id: "Iv1.client",
        client_secret: "oauth-client-secret",
        webhook_secret: "the-webhook-secret",
        pem: TEST_PEM,
        html_url: "https://github.com/apps/valet-acme",
      },
    }),
    ...overrides,
  });
  const state = await fetchManifestState(baseUrl);
  const res = await fetch(`${baseUrl}/api/org/github-app/setup?code=some-code&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  return { webhookSecret: "the-webhook-secret", fixture: f };
}

function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function postWebhook(baseUrl: string, event: string, payload: unknown, signature: string) {
  const body = JSON.stringify(payload);
  return fetch(`${baseUrl}/webhooks/github-app`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-github-event": event, "x-hub-signature-256": signature },
    body,
  });
}

describe("GET /api/org/github-app", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
  });

  it("reports unconfigured with an empty installations list and manual webhook mode", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body).toEqual({
      configured: false,
      installations: [],
      webhook: { mode: "manual" },
      // No installation rows remain after the delete, so nothing to date from.
      installationsCheckedAt: null,
    });
  });

  it("reports public webhook mode when VALET_PUBLIC_URL is set", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    process.env.VALET_PUBLIC_URL = "https://valet.example.com";
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.webhook.mode).toBe("public");
  });
});

describe("POST /api/org/github-app/manifest", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("builds a manual-mode manifest (no VALET_PUBLIC_URL): empty default_events, inactive placeholder hook", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostGithubAppManifestResponse;
    expect(body.url).toBe("https://github.com/settings/apps/new");
    expect(body.manifest.default_events).toEqual([]);
    // No public URL → hook_attributes omitted entirely: GitHub validates
    // hook URL reachability even with active:false, so a localhost
    // placeholder got the whole manifest rejected.
    expect(body.manifest.hook_attributes).toBeUndefined();
    // User-OAuth callback registered at creation (distinct from
    // redirect_url) — without it the App can't do user connects at all.
    expect(body.manifest.callback_urls).toHaveLength(1);
    expect(body.manifest.callback_urls[0]).toContain("/api/me/github/callback");
    expect(body.manifest.public).toBe(true);
    expect(body.manifest.default_permissions).toEqual({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
      actions: "write",
      checks: "read",
      statuses: "read",
    });
    expect(body.manifest.redirect_url).toContain("/api/org/github-app/setup");
    expect(typeof body.state).toBe("string");
  });

  it("permission/event overrides replace the defaults verbatim, bad levels 400", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "org:acme",
        permissions: { contents: "read", metadata: "read" },
        events: ["push"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostGithubAppManifestResponse;
    expect(body.url).toBe("https://github.com/organizations/acme/settings/apps/new");
    // Replace-not-merge: deselected defaults stay off.
    expect(body.manifest.default_permissions).toEqual({ contents: "read", metadata: "read" });

    const bad = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: { contents: "sudo" } }),
    });
    expect(bad.status).toBe(400);
  });

  it("builds a public-mode manifest when VALET_PUBLIC_URL is set: non-empty default_events, active hook", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    process.env.VALET_PUBLIC_URL = "https://valet.example.com";
    const res = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as PostGithubAppManifestResponse;
    // Every ingestable trigger family, and NOTHING GitHub delivers on its
    // own. `ping` and the App-lifecycle events are the exclusions.
    const triggerFamilies = githubPlugin.triggers!.map((t) => t.id.slice("github.".length));
    expect(body.manifest.default_events.sort()).toEqual(
      triggerFamilies.filter((e) => e !== "ping").sort(),
    );
    expect(body.manifest.default_events).not.toContain("ping");
    // GitHub REJECTS the whole manifest when these appear — it delivers
    // them to every App regardless, so subscribing is both unnecessary and
    // fatal ("Default events unsupported: installation and
    // installation_repositories"). They also map to no permission, which
    // trips a second rejection. Asserting their ABSENCE is the regression
    // guard: an earlier version of this test asserted their presence and so
    // locked in a manifest GitHub always refused.
    expect(body.manifest.default_events).not.toContain("installation");
    expect(body.manifest.default_events).not.toContain("installation_repositories");
    expect(body.manifest.hook_attributes).toEqual({ url: "https://valet.example.com/webhooks/github-app" });
  });

  it("routes an org target to the organization app-creation URL", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ target: "org:acme-corp" }),
    });
    const body = (await res.json()) as PostGithubAppManifestResponse;
    expect(body.url).toBe("https://github.com/organizations/acme-corp/settings/apps/new");
  });
});

describe("GET /api/org/github-app/setup", () => {
  it("400s when code or state is missing", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app/setup?code=abc`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("400s on a tampered state", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const state = await fetchManifestState(api.baseUrl);
    const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    const res = await fetch(
      `${api.baseUrl}/api/org/github-app/setup?code=abc&state=${encodeURIComponent(tampered)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid or expired state" });
  });

  it("409s when GitHub rejects the manifest code", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ convertManifest: () => ({ status: 404, body: { message: "not found" } }) });
    const state = await fetchManifestState(api.baseUrl);
    const res = await fetch(
      `${api.baseUrl}/api/org/github-app/setup?code=bad-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(409);
  });

  it("502s when GitHub's conversion endpoint 5xxs", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ convertManifest: () => ({ status: 503, body: { message: "unavailable" } }) });
    const state = await fetchManifestState(api.baseUrl);
    const res = await fetch(
      `${api.baseUrl}/api/org/github-app/setup?code=bad-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(502);
  });

  it("exchanges the code, saves the app config with no secrets ever surfaced, and runs discovery", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { fixture: f } = await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({
        body: [{ id: 111, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });
    expect(f.calls.some((c) => c.path === "/app-manifests/some-code/conversions")).toBe(true);
    expect(f.calls.some((c) => c.path === "/app/installations")).toBe(true);

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await getRes.json()) as GetGithubAppResponse;
    expect(body.configured).toBe(true);
    expect(body.app).toEqual({
      appId: "42",
      appSlug: "valet-acme",
      htmlUrl: "https://github.com/apps/valet-acme",
      installUrl: "https://github.com/apps/valet-acme/installations/new",
    });
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]).toMatchObject({ accountLogin: "acme", accountType: "Organization", suspended: false });

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("oauth-client-secret");
    expect(raw).not.toContain("the-webhook-secret");
    expect(raw).not.toContain(TEST_PEM);
  });

  it("accepts a webhook-less conversion (webhook_secret: null) — the no-public-URL path", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await setupConfiguredOrg(api.baseUrl, {
      convertManifest: () => ({
        body: {
          id: 4242,
          slug: "valet-acme",
          name: "Valet Acme",
          client_id: "Iv1.client",
          client_secret: "oauth-client-secret",
          // GitHub returns null here when the manifest omitted
          // hook_attributes (no public URL / delivery toggled off).
          webhook_secret: null,
          pem: TEST_PEM,
          html_url: "https://github.com/apps/valet-acme",
        },
      }),
    });

    const get = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await get.json()) as GetGithubAppResponse;
    expect(body.configured).toBe(true);
    expect(body.app?.appId).toBe("4242");
  });
});

describe("POST /api/org/github-app/credential", () => {
  /** What GitHub's `GET /app` answers for the app behind `TEST_PEM`. */
  const APP_RECORD = {
    id: 4242,
    owner: { id: githubAccountId("acme"), login: "acme", type: "Organization" },
    slug: "existing-app",
    node_id: "MDM6QXBwMQ==",
    client_id: "Iv1.existing",
    name: "Existing App",
    html_url: "https://github.com/apps/existing-app",
    permissions: {},
    events: [],
    installations_count: 1,
  };

  async function postCredential(baseUrl: string, body: unknown, headers = HEADERS) {
    return fetch(`${baseUrl}/api/org/github-app/credential`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("403s for a non-admin org member", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await postCredential(api.baseUrl, { appId: "4242", privateKey: TEST_PEM }, MEMBER_HEADERS);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
  });

  it("saves a pasted credential, fills the app fields from GitHub, and reports it configured", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const f = useFixture({
      getApp: () => ({ body: APP_RECORD }),
      listInstallations: () => ({
        body: [{ id: 111, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });

    const res = await postCredential(api.baseUrl, {
      appId: "4242",
      privateKey: TEST_PEM,
      oauthClientSecret: "pasted-oauth-secret",
      webhookSecret: "pasted-webhook-secret",
    });
    expect(res.status).toBe(200);

    // Verified before it was stored — and with the App JWT, not a token.
    const verifyCall = f.calls.find((c) => c.path === "/app");
    expect(verifyCall).toBeDefined();
    expect(verifyCall?.authHeader?.startsWith("Bearer ")).toBe(true);

    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.configured).toBe(true);
    expect(body.source).toBe("org");
    // Slug, page URL and app id all come from GitHub, so the admin never
    // typed them.
    expect(body.app).toEqual({
      appId: "4242",
      appSlug: "existing-app",
      htmlUrl: "https://github.com/apps/existing-app",
      installUrl: "https://github.com/apps/existing-app/installations/new",
    });
    // The save ran discovery, so the installation is already listed.
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0].accountLogin).toBe("acme");

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const fetched = (await getRes.json()) as GetGithubAppResponse;
    expect(fetched.configured).toBe(true);
    expect(fetched.app?.appId).toBe("4242");
  });

  it("never echoes the pasted secrets back, on the save reply or on a later read", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ getApp: () => ({ body: APP_RECORD }) });

    const res = await postCredential(api.baseUrl, {
      appId: "4242",
      privateKey: TEST_PEM,
      oauthClientSecret: "pasted-oauth-secret",
      webhookSecret: "pasted-webhook-secret",
    });
    expect(res.status).toBe(200);

    const saveBody = await res.text();
    const getBody = await (await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS })).text();
    for (const raw of [saveBody, getBody]) {
      expect(raw).not.toContain("pasted-oauth-secret");
      expect(raw).not.toContain("pasted-webhook-secret");
      expect(raw).not.toContain(TEST_PEM);
      expect(raw).not.toContain("PRIVATE KEY");
    }
  });

  it("accepts a base64-encoded private key, the same as the environment fallback", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ getApp: () => ({ body: APP_RECORD }) });

    const res = await postCredential(api.baseUrl, {
      appId: "4242",
      privateKey: Buffer.from(TEST_PEM, "utf8").toString("base64"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.configured).toBe(true);
  });

  it("refuses a key GitHub rejects, and stores nothing", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ getApp: () => ({ status: 401, body: { message: "A JSON web token could not be decoded" } }) });

    const res = await postCredential(api.baseUrl, { appId: "999", privateKey: TEST_PEM });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("GitHub rejected this App ID and private key");
    // The message names what to do about it, not just what went wrong.
    expect(error).toContain("generate a new private key");

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    expect((await getRes.json()) as GetGithubAppResponse).toEqual({
      configured: false,
      installations: [],
      webhook: { mode: "manual" },
      // Declared on every reply. No rows means nothing to date from.
      installationsCheckedAt: null,
    });
  });

  it("refuses a private key that is not a PEM without calling GitHub", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const f = useFixture({ getApp: () => ({ body: APP_RECORD }) });

    const res = await postCredential(api.baseUrl, { appId: "4242", privateKey: "not a key at all" });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("not a PEM");
    expect(f.calls.some((c) => c.path === "/app")).toBe(false);
  });

  it("refuses a missing app id or private key, naming both fields", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await postCredential(api.baseUrl, {});
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("the app id");
    expect(error).toContain("the private key");

    const noKey = await postCredential(api.baseUrl, { appId: "4242" });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { error: string }).error).toContain("the private key");
  });

  it("falls back to the supplied slug and client id when GitHub reports neither", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ getApp: () => ({ body: { id: 4242, name: "Existing App", permissions: {}, events: [] } }) });

    const res = await postCredential(api.baseUrl, {
      appId: "4242",
      privateKey: TEST_PEM,
      appSlug: "typed-slug",
      oauthClientId: "Iv1.typed",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.app?.appSlug).toBe("typed-slug");
    // No html_url from GitHub either, so it is derived from the slug.
    expect(body.app?.htmlUrl).toBe("https://github.com/apps/typed-slug");
  });

  it("refuses when GitHub reports no slug and none was supplied", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ getApp: () => ({ body: { id: 4242, name: "Existing App", permissions: {}, events: [] } }) });

    const res = await postCredential(api.baseUrl, { appId: "4242", privateKey: TEST_PEM });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Enter it yourself");
  });

  it("a pasted credential shadows the environment fallback, the same as the manifest flow", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    setEnvApp();
    useFixture({ getApp: () => ({ body: APP_RECORD }) });

    const res = await postCredential(api.baseUrl, { appId: "4242", privateKey: TEST_PEM });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await getRes.json()) as GetGithubAppResponse;
    expect(body.source).toBe("org");
    expect(body.app?.appId).toBe("4242");
  });

  it("the stored credential works: the webhook verifies against the pasted secret", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({ getApp: () => ({ body: APP_RECORD }) });
    expect(
      (await postCredential(api.baseUrl, { appId: "4242", privateKey: TEST_PEM, webhookSecret: "pasted-webhook-secret" }))
        .status,
    ).toBe(200);

    const now = Date.now();
    await api.providers.db.insert(githubInstallations).values({
      id: "ghi_pasted",
      orgId: "local-org",
      installationId: 999,
      accountLogin: "acme",
      accountId: githubAccountId("acme"),
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      createdAt: now,
      updatedAt: now,
    });

    const payload = { action: "suspend", installation: { id: 999, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const wrong = signWebhookBody(JSON.stringify(payload), "some-other-secret");
    expect((await postWebhook(api.baseUrl, "installation", payload, wrong)).status).toBe(403);

    const sig = signWebhookBody(JSON.stringify(payload), "pasted-webhook-secret");
    expect((await postWebhook(api.baseUrl, "installation", payload, sig)).status).toBe(204);

    const [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_pasted"));
    expect(row.suspended).toBe(true);
  });
});

describe("POST /api/org/github-app/refresh", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app/refresh`, { method: "POST", headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("re-runs discovery and returns the refreshed list", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    let installations: unknown[] = [];
    await setupConfiguredOrg(api.baseUrl, { listInstallations: () => ({ body: installations }) });

    installations = [{ id: 222, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null }];
    const res = await fetch(`${api.baseUrl}/api/org/github-app/refresh`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0].accountLogin).toBe("acme");
  });
});

describe("DELETE /api/org/github-app", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { method: "DELETE", headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("removes the config and every installation row, degrading gracefully (no refusal)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({
        body: [{ id: 111, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/org/github-app`, { method: "DELETE", headers: HEADERS });
    expect(delRes.status).toBe(204);

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await getRes.json()) as GetGithubAppResponse;
    expect(body).toEqual({
      configured: false,
      installations: [],
      webhook: { mode: "manual" },
      // No installation rows remain after the delete, so nothing to date from.
      installationsCheckedAt: null,
    });
  });
});

describe("GITHUB_APP_* env fallback (admin routes)", () => {
  it("GET reports the env app as configured with source environment", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    setEnvApp();
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.configured).toBe(true);
    expect(body.source).toBe("environment");
    expect(body.app).toEqual({
      appId: "777",
      appSlug: "valet-env",
      htmlUrl: "https://github.com/apps/valet-env",
      installUrl: "https://github.com/apps/valet-env/installations/new",
    });
    expect(JSON.stringify(body)).not.toContain("env-oauth-secret");
    expect(JSON.stringify(body)).not.toContain("env-hook-secret");
  });

  it("an app saved through the manifest flow shadows the env fallback (source org)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    setEnvApp();
    await setupConfiguredOrg(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.source).toBe("org");
    expect(body.app?.appId).toBe("42");
  });

  it("refresh discovers installations with the env app", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    setEnvApp();
    useFixture({
      listInstallations: () => ({
        body: [{ id: 888, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });
    const res = await fetch(`${api.baseUrl}/api/org/github-app/refresh`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0].accountLogin).toBe("acme");
  });

  it("DELETE removes installation rows but cannot remove the env config (still configured)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    setEnvApp();
    const delRes = await fetch(`${api.baseUrl}/api/org/github-app`, { method: "DELETE", headers: HEADERS });
    expect(delRes.status).toBe(204);
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.configured).toBe(true);
    expect(body.source).toBe("environment");
  });
});

describe("POST /webhooks/github-app", () => {
  async function seedInstallationRow(overrides: Partial<typeof githubInstallations.$inferInsert> = {}) {
    const now = Date.now();
    await api!.providers.db.insert(githubInstallations).values({
      id: "ghi_seed",
      orgId: "local-org",
      installationId: 999,
      accountLogin: "acme",
      accountId: githubAccountId("acme"),
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }

  it("403s on a bad signature", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    const payload = { action: "suspend", installation: { id: 999, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const badSig = signWebhookBody(JSON.stringify(payload), `${webhookSecret}-wrong`);
    const res = await postWebhook(api.baseUrl, "installation", payload, badSig);
    expect(res.status).toBe(403);
  });

  it("403s with no signature header at all", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await setupConfiguredOrg(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/webhooks/github-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-github-event": "installation" },
      body: JSON.stringify({ action: "suspend", installation: { id: 999 } }),
    });
    expect(res.status).toBe(403);
  });

  it("204s and ignores unknown event types", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    const payload = { hello: "world" };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "star", payload, sig);
    expect(res.status).toBe(204);
  });

  it("flips suspended=true on installation.suspend, suspended=false on installation.unsuspend", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow();

    const suspendPayload = { action: "suspend", installation: { id: 999, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const suspendSig = signWebhookBody(JSON.stringify(suspendPayload), webhookSecret);
    const suspendRes = await postWebhook(api.baseUrl, "installation", suspendPayload, suspendSig);
    expect(suspendRes.status).toBe(204);

    let [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(row.suspended).toBe(true);

    const unsuspendPayload = { action: "unsuspend", installation: { id: 999, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const unsuspendSig = signWebhookBody(JSON.stringify(unsuspendPayload), webhookSecret);
    const unsuspendRes = await postWebhook(api.baseUrl, "installation", unsuspendPayload, unsuspendSig);
    expect(unsuspendRes.status).toBe(204);

    [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(row.suspended).toBe(false);
  });

  it("removes the row on installation.deleted", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow();

    const payload = { action: "deleted", installation: { id: 999, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "installation", payload, sig);
    expect(res.status).toBe(204);

    const rows = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(rows).toHaveLength(0);
  });

  it("re-derives repositorySelection and touches updatedAt on installation_repositories", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow({ repositorySelection: "all", updatedAt: 1_000 });

    const payload = {
      action: "added",
      repository_selection: "selected",
      installation: { id: 999, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } },
    };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "installation_repositories", payload, sig);
    expect(res.status).toBe(204);

    const [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(row.repositorySelection).toBe("selected");
    expect(row.updatedAt).toBeGreaterThan(1_000);
  });

  it("backfills a legacy owner row before webhook admission", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getInstallation: () => ({ body: { id: 999,
        account: { id: githubAccountId("acme"), login: "acme", type: "Organization" },
      } }),
    });
    await seedInstallationRow({ accountId: null });
    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_legacy", orgId: "local-org", ownerType: "org", ownerId: "local-org", name: "PRs",
      eventKeys: ["github.pull_request.opened"], filters: [], target: { kind: "orchestrator" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });
    expect((await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "legacy-delivery")).status).toBe(204);
    expect(await api.providers.db.select().from(events)).toHaveLength(1);
    expect(await api.providers.db.select().from(githubInstallations)).toMatchObject([{ accountId: githubAccountId("acme") }]);
  });

  it.each(["owner", "member"])("targets a signed %s creation even when paged listing omits it", async (kind) => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const account = kind === "owner"
      ? { id: githubAccountId("acme"), login: "acme", type: "Organization" }
      : { id: 20, login: "alice", type: "User" };
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({ body: [] }),
      getInstallation: () => ({ body: { id: 555, account } }),
      getUser: () => ({ body: { id: account.id, login: account.login } }),
    });
    if (kind === "member") {
      await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
        type: "oauth2", accessToken: "member-token", metadata: { login: "alice" },
      });
      // Legacy connections have only login metadata; admission must verify the exact token live.
    }
    const before = fixture!.calls.filter((call) => call.path === "/app/installations").length;
    const payload = { action: "created", installation: { id: 555, account } };
    expect((await postWebhook(api.baseUrl, "installation", payload, signWebhookBody(JSON.stringify(payload), webhookSecret))).status).toBe(204);
    expect(await api.providers.db.select().from(githubInstallations)).toMatchObject([{ accountId: account.id, installationId: 555 }]);
    expect(fixture!.calls.filter((call) => call.path === "/app/installations")).toHaveLength(before);
    expect(fixture!.calls.filter((call) => call.path === "/app/installations/555")).toHaveLength(1);
  });

  it("recovers a missed creation on the next signed event with a targeted lookup", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    let outage = true;
    const account = { id: githubAccountId("acme"), login: "acme", type: "Organization" };
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getInstallation: () => outage ? { status: 502, body: {} } : { body: { id: 777, account } },
    });
    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({ id: "sub_recover", orgId: "local-org", ownerType: "org", ownerId: "local-org",
      name: "Recovered PRs", eventKeys: ["github.pull_request.opened"], filters: [], target: { kind: "orchestrator" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now });
    const created = { action: "created", installation: { id: 777, account } };
    expect((await postForwardedWebhook(api.baseUrl, "installation", created, webhookSecret, "missed-created")).status).toBe(503);
    expect(await api.providers.db.select().from(githubInstallations)).toEqual([]);
    outage = false;
    const pr = { ...PR_OPENED_PAYLOAD, installation: { id: 777 } };
    expect((await postForwardedWebhook(api.baseUrl, "pull_request", pr, webhookSecret, "recovered-pr")).status).toBe(204);
    expect(await api.providers.db.select().from(githubInstallations)).toMatchObject([{ installationId: 777, accountId: account.id }]);
    expect(await api.providers.db.select().from(events)).toHaveLength(1);
    expect(await api.providers.db.select().from(eventDropLog)).toMatchObject([{ conversationKey: "missed-created" }]);
    expect(fixture!.calls.filter((call) => call.path === "/app/installations")).toHaveLength(1); // Setup only.
  });

  it.each([401, 403, "expired", 502, "secondary", 404, 408, 422] as const)("classifies member identity failure %s for admission and discovery", async (failure) => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getUser: () => ({ status: failure === "expired" ? 200 : failure === "secondary" ? 403 : failure,
        body: failure === 403 ? { message: "Bad credentials" } : failure === "secondary"
          ? { message: "You have exceeded a secondary rate limit. Please wait before you try again." }
          : { id: 20, login: "alice" },
      }),
      listInstallations: () => ({ body: [{ id: 555, account: { id: 20, login: "alice", type: "User" } }] }),
    });
    await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "oauth2", accessToken: "bad-token", ...(failure === "expired" ? { expiresAt: Date.now() - 1 } : {}), metadata: { login: "alice" },
    });
    await seedInstallationRow({ installationId: 555, accountId: 20, accountType: "User", accountLogin: "alice", linkedUserId: "test-member" });
    const transient = ![401, 403, "expired"].includes(failure);
    const pr = { ...PR_OPENED_PAYLOAD, installation: { id: 555 } };
    expect((await postForwardedWebhook(api.baseUrl, "pull_request", pr, webhookSecret, `identity-${failure}`)).status).toBe(transient ? 503 : 204);
    const { discoverInstallations } = await import("../services/github-app.js");
    await discoverInstallations({ db: api.providers.db, credentials: api.providers.engineCredentials,
      key: deriveSecretKey(api.providers.encryptionKey), apiUrl: fixture!.url }, "local-org");
    expect(await api.providers.db.select().from(githubInstallations)).toHaveLength(transient ? 1 : 0);
    const [drop] = await api.providers.db.select().from(eventDropLog);
    expect(drop.conversationKey).toBe(`identity-${failure}`);
    expect(drop.detail.includes("Redeliver")).toBe(transient);
    if (failure === "expired") expect(fixture!.calls.filter((call) => call.path === "/user")).toHaveLength(0);
  });

  it.each(["suspend", "deleted"])("revocation %s wins over discovery blocked on member identity", async (mode) => {
    const action = mode === "suspend" ? "suspend" : "deleted";
    api = await bootTestApi({ plugins: [githubPlugin] });
    let listPersonal = false;
    const installation = { id: 555, account: { id: 20, login: "alice", type: "User" }, suspended_at: null };
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getUser: () => ({ body: { id: 20, login: "alice" } }),
      listInstallations: () => ({ body: listPersonal ? [installation] : [] }),
    });
    await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "oauth2", accessToken: "member-token", metadata: { login: "alice" },
    });
    await seedInstallationRow({ installationId: 555, accountId: 20,
      accountType: "User", accountLogin: "alice", linkedUserId: "test-member" });
    listPersonal = true;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const d = { db: api.providers.db, credentials: api.providers.engineCredentials,
      key: deriveSecretKey(api.providers.encryptionKey), apiUrl: fixture!.url,
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith("/user")) { entered(); await blocked; }
        return fetch(url, init);
      }) as typeof fetch,
    };
    const discovery = discoverInstallations(d, "local-org");
    await started;
    try {
      const payload = { action, installation: { id: 555 } };
      expect((await postWebhook(api.baseUrl, "installation", payload, signWebhookBody(JSON.stringify(payload), webhookSecret))).status).toBe(204);
      const rows = await api.providers.db.select().from(githubInstallations);
      if (action === "deleted") expect(rows).toEqual([]);
      else expect(rows).toMatchObject([{ suspended: true }]);
    } finally { release(); }
    expect(await discovery).toBe("stale");
    const rows = await api.providers.db.select().from(githubInstallations);
    if (action === "deleted") expect(rows).toEqual([]);
    else expect(rows).toMatchObject([{ suspended: true }]);
    expect(await mintInstallationToken(d, "local-org", "alice", "test-member")).toBeNull();
  });

  it("stranger revocations perform no mutation or fence bump", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    const transaction = vi.spyOn(api.providers.db, "transaction");
    for (let i = 0; i < 12; i++) {
      const payload = { action: i % 2 ? "suspend" : "deleted", installation: { id: 10_000 + i } };
      expect((await postForwardedWebhook(api.baseUrl, "installation", payload, webhookSecret, `stranger-revoke-${i}`)).status).toBe(204);
    }
    expect(transaction).not.toHaveBeenCalled(); // The org FOR UPDATE lock and all mutation writes live inside this transaction.
    expect(await api.providers.db.select({ revision: orgs.githubInstallationRevision }).from(orgs)).toEqual([{ revision: 0 }]);
    expect(await api.providers.db.select().from(githubInstallations)).toEqual([]);
    expect(await api.providers.db.select().from(eventDropLog)).toEqual([]);
  });

  it.each(["creation", "recovery", "refresh", "stranger stream"])("discovery boundary handles %s without empty-success loss", async (kind) => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const account = { id: githubAccountId("acme"), login: "acme", type: "Organization" };
    let listTarget = false;
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getInstallation: () => ({ body: { id: 777, account } }),
      listInstallations: () => ({ body: listTarget ? [{ id: 777, account }] : [] }),
    });
    if (kind !== "stranger stream") await seedInstallationRow();
    listTarget = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const nativeFetch = globalThis.fetch;
    let lookups = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const targeted = String(url) === `${fixture!.url}/app/installations/777`;
      const listing = kind === "refresh" && String(url).startsWith(`${fixture!.url}/app/installations?`);
      if (targeted || listing) {
        lookups++;
        if (lookups === (kind === "recovery" ? 2 : 1)) { entered(); await blocked; }
      }
      return nativeFetch(url, init);
    });
    const transaction = vi.spyOn(api.providers.db, "transaction");
    const created = { action: "created", installation: { id: 777, account } };
    const pr = { ...PR_OPENED_PAYLOAD, installation: { id: 777 } };
    const pending = kind === "refresh"
      ? fetch(`${api.baseUrl}/api/org/github-app/refresh`, { method: "POST", headers: HEADERS })
      : postForwardedWebhook(api.baseUrl, kind === "recovery" ? "pull_request" : "installation",
        kind === "recovery" ? pr : created, webhookSecret, `boundary-${kind}`);
    await started;
    try {
      if (kind === "stranger stream") {
        for (let i = 0; i < 12; i++) {
          const payload = { action: i % 2 ? "suspend" : "deleted", installation: { id: 10_000 + i } };
          expect((await postForwardedWebhook(api.baseUrl, "installation", payload, webhookSecret, `stream-${i}`)).status).toBe(204);
        }
        expect(transaction).not.toHaveBeenCalled();
      } else {
        const payload = { action: "deleted", installation: { id: 999 } };
        expect((await postForwardedWebhook(api.baseUrl, "installation", payload, webhookSecret, "held-delete")).status).toBe(204);
      }
    } finally { release(); }
    const response = await pending;
    expect(response.status).toBe(kind === "stranger stream" ? 204 : kind === "refresh" ? 502 : 503);
    const installations = await api.providers.db.select().from(githubInstallations);
    if (kind === "stranger stream") {
      expect(installations).toMatchObject([{ installationId: 777 }]);
      expect(await api.providers.db.select().from(eventDropLog)).toEqual([]);
    } else {
      expect(installations).toEqual([]);
      if (kind !== "refresh") expect(await api.providers.db.select().from(eventDropLog)).toMatchObject([{ conversationKey: `boundary-${kind}` }]);
    }
    if (kind === "recovery") {
      expect((await postForwardedWebhook(api.baseUrl, "pull_request", pr, webhookSecret, "recovery-cached")).status).toBe(503);
      expect(lookups).toBe(2); // Cached unavailable, never cached admitted.
      expect(await api.providers.db.select().from(events)).toEqual([]);
    }
  });

  it("retains a legacy null-ID personal row during outage without granting mint authority", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    let listPersonal = false;
    let outage = true;
    const installation = { id: 555, account: { id: 20, login: "alice", type: "User" } };
    await setupConfiguredOrg(api.baseUrl, {
      getUser: () => outage ? { status: 502, body: {} } : { body: { id: 20, login: "alice" } },
      listInstallations: () => ({ body: listPersonal ? [installation] : [] }),
    });
    await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "oauth2", accessToken: "member-token", metadata: { login: "alice" },
    });
    const d = { db: api.providers.db, credentials: api.providers.engineCredentials,
      key: deriveSecretKey(api.providers.encryptionKey), apiUrl: fixture!.url };
    const cachedToken = encryptSecret("legacy-cached-token", d.key);
    await seedInstallationRow({ installationId: 555, accountId: null, accountType: "User", accountLogin: "alice",
      linkedUserId: "test-member", cachedToken, cachedTokenExpiresAt: Date.now() + 3600_000 });
    listPersonal = true;
    expect(await discoverInstallations(d, "local-org")).toEqual([]);
    expect(await api.providers.db.select().from(githubInstallations)).toMatchObject([{
      accountId: null, linkedUserId: "test-member", cachedToken,
    }]);
    expect(await mintInstallationToken(d, "local-org", "alice", "test-member")).toBeNull();
    expect(fixture!.calls.some((call) => call.path.includes("access_tokens"))).toBe(false);
    outage = false;
    expect(await discoverInstallations(d, "local-org")).toMatchObject([{ accountId: 20, linkedUserId: "test-member" }]);
    expect(await mintInstallationToken(d, "local-org", "alice", "test-member")).toBe("legacy-cached-token");
  });

  it("a signed rename cannot replace a stale linked member's verified identity", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await api.providers.db.insert(users).values({ id: "test-member", name: "Member", email: "rename-member@example.com" }).onConflictDoNothing();
    await api.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: "test-member", role: "member" }).onConflictDoNothing();
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getUser: () => ({ body: { id: 30, login: "member-30" } }),
    });
    await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "api_key", accessToken: "token-30", metadata: { login: "member-30" },
    });
    const d = { db: api.providers.db, credentials: api.providers.engineCredentials,
      key: deriveSecretKey(api.providers.encryptionKey), apiUrl: fixture!.url };
    expect(await saveVerifiedGithubIdentity(d, "test-member", { id: 30, login: "member-30" }, "token-30")).toBe(true);
    await seedInstallationRow({ installationId: 555, accountId: 20, accountLogin: "old-20", accountType: "User", linkedUserId: "test-member" });
    const before = await api.providers.engineCredentials.get({ type: "user", id: "test-member" }, "github");
    const payload = { action: "renamed", installation: { id: 555, account: { id: 20, login: "new-20", type: "User" } } };
    const userCalls = fixture!.calls.filter((call) => call.path === "/user").length;
    expect((await postWebhook(api.baseUrl, "installation_target", payload, signWebhookBody(JSON.stringify(payload), webhookSecret))).status).toBe(204);
    expect(await api.providers.engineCredentials.get({ type: "user", id: "test-member" }, "github")).toEqual(before);
    expect(fixture!.calls.filter((call) => call.path === "/user")).toHaveLength(userCalls);
    expect(await mintInstallationToken(d, "local-org", "new-20", "test-member")).toBeNull();
    expect(await api.providers.db.select().from(githubInstallations)).toMatchObject([{ accountId: 20, accountLogin: "new-20" }]);
  });

  it("returns retryable failure when webhook ownership cannot be established", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    let outage = false;
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getApp: () => outage ? { status: 401, body: {} } : { body: { owner: { id: githubAccountId("acme"), login: "acme" } } },
    });
    await seedInstallationRow();
    // Change config binding to bypass the in-process owner cache.
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github_app", {
      type: "service_account", apiKey: TEST_PEM, accessToken: "secret", refreshToken: webhookSecret,
      metadata: { appId: "99", appSlug: "fixture", oauthClientId: "client", htmlUrl: "https://github.com/apps/fixture" },
    });
    outage = true;
    expect((await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "owner-outage")).status).toBe(503);
    expect(await api.providers.db.select().from(eventDropLog)).toMatchObject([{
      reason: "event_not_ingestable", conversationKey: "owner-outage",
      detail: expect.stringContaining("Redeliver manually or through the GitHub API"),
    }]);
    expect(await api.providers.db.select().from(events)).toEqual([]);
  });

  it("suppresses drop records when 70 unheld IDs exhaust the recovery budget", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getInstallation: () => ({ status: 502, body: {} }),
    });
    for (let i = 0; i < 70; i++) {
      const pr = { ...PR_OPENED_PAYLOAD, installation: { id: 10_000 + i } };
      expect((await postForwardedWebhook(api.baseUrl, "pull_request", pr, webhookSecret, `budget-${i}`)).status).toBe(503);
    }
    const drops = await api.providers.db.select().from(eventDropLog);
    expect(drops).toHaveLength(64);
    expect(drops.some((drop) => Number(drop.conversationKey?.split("-")[1]) >= 64)).toBe(false);
    expect(fixture!.calls.filter((call) => /^\/app\/installations\//.test(call.path))).toHaveLength(64);
    expect(await api.providers.db.select().from(githubInstallations)).toEqual([]);
  });

  it("records only one unheld retry during a cached lookup outage", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getInstallation: () => ({ status: 502, body: {} }),
    });
    const pr = { ...PR_OPENED_PAYLOAD, installation: { id: 777 } };
    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      postForwardedWebhook(api!.baseUrl, "pull_request", pr, webhookSecret, `outage-${i}`)));
    expect(responses.map((response) => response.status)).toEqual(Array(5).fill(503));
    expect(await api.providers.db.select().from(eventDropLog)).toHaveLength(1);
    expect(fixture!.calls.filter((call) => call.path === "/app/installations/777")).toHaveLength(1);
  });

  it("records every retry delivery for a held installation", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getUser: () => ({ status: 502, body: {} }),
    });
    await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "oauth2", accessToken: "member-token", metadata: { login: "alice" },
    });
    await seedInstallationRow({ installationId: 555, accountId: 20, accountType: "User", accountLogin: "alice", linkedUserId: "test-member" });
    for (let i = 0; i < 5; i++) {
      const pr = { ...PR_OPENED_PAYLOAD, installation: { id: 555 } };
      expect((await postForwardedWebhook(api.baseUrl, "pull_request", pr, webhookSecret, `held-${i}`)).status).toBe(503);
    }
    expect(await api.providers.db.select().from(eventDropLog)).toHaveLength(5);
  });

  it("does not grow drop logs for signed stranger-installation deliveries", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    for (let i = 0; i < 25; i++) {
      const account = { id: 10_000 + i, login: `stranger-${i}`, type: "User" };
      const payload = { action: "created", installation: { id: 10_000 + i, account } };
      expect((await postForwardedWebhook(api.baseUrl, "installation", payload, webhookSecret, `stranger-${i}`)).status).toBe(204);
      const push = { ...PR_OPENED_PAYLOAD, installation: { id: 10_000 + i } };
      expect((await postForwardedWebhook(api.baseUrl, "pull_request", push, webhookSecret, `stranger-pr-${i}`)).status).toBe(204);
    }
    expect(await api.providers.db.select().from(eventDropLog)).toEqual([]);
    expect(await api.providers.db.select().from(githubInstallations)).toEqual([]);
  });

  it("upserts a new row via discovery on installation.created", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({
        body: [{ id: 555, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });

    const payload = { action: "created", installation: { id: 555, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "installation", payload, sig);
    expect(res.status).toBe(204);

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await getRes.json()) as GetGithubAppResponse;
    expect(body.installations.some((i) => i.accountLogin === "acme")).toBe(true);
  });

  it("syncs owner and healthy member installations when another member verification fails", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    for (const login of ["alice", "bob"]) {
      await api.providers.db.insert(users).values({ id: login, name: login, email: `${login}@example.com` });
      await api.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: login, role: "member" });
      await api.providers.engineCredentials.save({ type: "user", id: login }, "github", {
        type: "oauth2", accessToken: `${login}-token`, metadata: { login },
      });
    }
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getUser: (auth) => ({ body: auth === "Bearer alice-token" ? { login: 42 } : { login: "bob" } }),
      listInstallations: () => ({ body: [
        { id: 1, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } },
        { id: 2, account: { login: "alice", type: "User" } },
        { id: 3, account: { login: "bob", type: "User" } },
      ] }),
    });
    const payload = { action: "created", installation: { id: 3 } };
    expect((await postWebhook(api.baseUrl, "installation", payload, signWebhookBody(JSON.stringify(payload), webhookSecret))).status).toBe(204);
    expect((await api.providers.db.select().from(githubInstallations)).map((row) => row.installationId).sort()).toEqual([1, 3]);
  });

  it("admits a User-owned App webhook with personal installations disabled", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await api.providers.db.update(orgs).set({ allowPersonalInstallations: false }).where(eq(orgs.id, "local-org"));
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getApp: () => ({ body: { owner: { id: githubAccountId("acme"), login: "acme", type: "User" } } }),
      listInstallations: () => ({ body: [{ id: 555, account: { login: "acme", type: "User" } }] }),
    });
    const payload = { action: "suspend", installation: { id: 555 } };
    expect((await postWebhook(api.baseUrl, "installation", payload, signWebhookBody(JSON.stringify(payload), webhookSecret))).status).toBe(204);
    expect(await api.providers.db.select().from(githubInstallations)).toMatchObject([{ installationId: 555, suspended: true }]);
  });

  it.each(["none", "membership", "toggle", "identity"])("personal webhook admission: %s", async (revocation) => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await api.providers.db.insert(users).values({ id: "test-member", name: "Member", email: "personal@example.com" }).onConflictDoNothing();
    await api.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: "test-member", role: "member" }).onConflictDoNothing();
    await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "oauth2", accessToken: "member-token", metadata: { login: "alice" },
    });
    let profileId = 20;
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      getUser: () => ({ body: { id: profileId, login: "alice" } }),
      listInstallations: () => ({ body: [{ id: 555, account: { id: 20, login: "alice", type: "User" } }] }),
    });
    if (revocation === "membership") await api.providers.db.delete(orgMembers).where(eq(orgMembers.userId, "test-member"));
    if (revocation === "toggle") await api.providers.db.update(orgs).set({ allowPersonalInstallations: false });
    if (revocation === "identity") {
      profileId = 21;
      await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
        type: "oauth2", accessToken: "other-token", metadata: { login: "alice", githubUserId: 20, githubIdentityProof: "forged" },
      });
    }
    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_personal", orgId: "local-org", ownerType: "org", ownerId: "local-org",
      name: "Personal PRs", eventKeys: ["github.pull_request.opened"], filters: [],
      target: { kind: "orchestrator" }, enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });
    const payload = { ...PR_OPENED_PAYLOAD, installation: { id: 555 } };
    expect((await postForwardedWebhook(api.baseUrl, "pull_request", payload, webhookSecret, `personal-${revocation}`)).status).toBe(204);
    const rows = await api.providers.db.select().from(events);
    expect(rows).toHaveLength(revocation === "none" ? 1 : 0);
    const drops = await api.providers.db.select().from(eventDropLog);
    if (revocation !== "none") expect(drops).toMatchObject([{
      reason: "event_not_ingestable", conversationKey: `personal-${revocation}`,
    }]);
    const status = await fetch(`${api.baseUrl}/api/me/github/org-status`);
    expect(await status.json()).toMatchObject({ installationCount: revocation === "none" ? 1 : 0 });
    if (revocation !== "membership") {
      const repos = await fetch(`${api.baseUrl}/api/repos`, { headers: MEMBER_HEADERS });
      expect(await repos.json()).toMatchObject({ installed: revocation === "none" });
    }
  });

  it.each(["deleted", "suspend"])("applies %s after personal policy revocation without an owner lookup", async (action) => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow({ accountType: "User", accountLogin: "alice", accountId: 20, linkedUserId: "test-member" });
    await api.providers.db.update(orgs).set({ allowPersonalInstallations: false });
    const before = fixture!.calls.length;
    const payload = { action, installation: { id: 999 } };
    expect((await postWebhook(api.baseUrl, "installation", payload, signWebhookBody(JSON.stringify(payload), webhookSecret))).status).toBe(204);
    expect(fixture!.calls.length).toBe(before);
    const rows = await api.providers.db.select().from(githubInstallations);
    if (action === "deleted") expect(rows).toEqual([]);
    else expect(rows).toMatchObject([{ suspended: true }]);
  });

  it("applies installation_target rename by immutable account ID", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow();
    const payload = { action: "renamed", installation: { id: 999 },
      account: { id: githubAccountId("acme"), login: "new-acme", type: "Organization" } };
    expect((await postWebhook(api.baseUrl, "installation_target", payload, signWebhookBody(JSON.stringify(payload), webhookSecret))).status).toBe(204);
    expect(await api.providers.db.select().from(githubInstallations)).toMatchObject([{ accountLogin: "new-acme" }]);
  });

  it("ignores a stranger's installation.created and all later trigger deliveries", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({ body: [{ id: 555, account: { login: "stranger", type: "User" } }] }),
    });
    const before = fixture!.calls.filter((call) => call.path.includes("/app/installations")).length;
    const created = { action: "created", installation: { id: 555, account: { id: 987, login: "stranger", type: "User" } } };
    expect((await postWebhook(api.baseUrl, "installation", created, signWebhookBody(JSON.stringify(created), webhookSecret))).status).toBe(204);
    expect(await api.providers.db.select().from(githubInstallations)).toEqual([]);
    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_stranger", orgId: "local-org", ownerType: "org", ownerId: "local-org", name: "PRs",
      eventKeys: ["github.pull_request.opened"], filters: [], target: { kind: "orchestrator" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });
    const pr = { ...PR_OPENED_PAYLOAD, installation: { id: 555 } };
    expect((await postForwardedWebhook(api.baseUrl, "pull_request", pr, webhookSecret, "stranger-delivery")).status).toBe(204);
    expect(await api.providers.db.select().from(events)).toEqual([]);
    expect(await api.providers.db.select().from(eventDeliveries)).toEqual([]);
  });

  it("drops a stale installation row for another organization before trigger dispatch", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow({ accountLogin: "other-org", accountId: githubAccountId("other-org") });
    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_other", orgId: "local-org", ownerType: "org", ownerId: "local-org", name: "PRs",
      eventKeys: ["github.pull_request.opened"], filters: [], target: { kind: "orchestrator" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });
    expect((await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "other-org-delivery")).status).toBe(204);
    expect(await api.providers.db.select().from(events)).toEqual([]);
  });

  // A push marks every matching enabled source due, whoever owns it, and
  // syncs none of them inline. Marking a personal source due used to be
  // skipped on the reasoning that it often has no App installation; true, and
  // it only moves that source's next poll forward.
  it("a push marks every matching source due and syncs none inline", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    const orgSource = await createContentSource(
      api.providers.db,
      { userId: "local-user", orgId: "local-org" },
      { repo: "tkhq/skills", ownerType: "org" },
    );
    const personal = await createContentSource(
      api.providers.db,
      { userId: "local-user", orgId: "local-org" },
      { repo: "tkhq/skills" },
    );
    const elsewhere = await createContentSource(
      api.providers.db,
      { userId: "local-user", orgId: "local-org" },
      { repo: "tkhq/other" },
    );
    // A new source is already due, so push them all out first: "due" is the
    // observable this asserts.
    const later = Date.now() + 3_600_000;
    await api.providers.db.update(contentSources).set({ nextAttemptAt: later });

    await seedInstallationRow();
    const payload = {
      installation: { id: 999 },
      ref: "refs/heads/main",
      repository: { full_name: "tkhq/skills", default_branch: "main" },
    };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "push", payload, sig);
    expect(res.status).toBe(204);

    const db = api.providers.db;
    const dueAt = async (id: string): Promise<number> => {
      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
      return row.nextAttemptAt;
    };
    expect(await dueAt(orgSource.id)).toBeLessThan(later);
    expect(await dueAt(personal.id)).toBeLessThan(later);
    expect(await dueAt(elsewhere.id)).toBe(later);
  });

  it("204s with no app configured anywhere", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const payload = { action: "suspend", installation: { id: 1 } };
    const res = await postWebhook(api.baseUrl, "installation", payload, "sha256=irrelevant");
    expect(res.status).toBe(204);
  });

  // ── Generic event-pipeline forwarding (event-system plan, Task 5) ──────

  async function postForwardedWebhook(
    baseUrl: string,
    event: string,
    payload: unknown,
    secret: string,
    deliveryId: string,
  ) {
    const body = JSON.stringify(payload);
    return fetch(`${baseUrl}/webhooks/github-app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signWebhookBody(body, secret),
      },
      body,
    });
  }

  const PR_OPENED_PAYLOAD = {
    installation: { id: 999 },
    action: "opened",
    pull_request: { number: 7, title: "Add thing" },
    repository: { full_name: "acme/widgets" },
    sender: { id: 1234, login: "octocat" },
  };

  it("forwards a pull_request webhook into the event pipeline: events row + matched pending delivery", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow();

    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_gh",
      orgId: "local-org",
      ownerType: "org",
      ownerId: "local-org",
      name: "PR opened",
      eventKeys: ["github.pull_request.opened"],
      filters: [],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: "local-user",
      createdAt: now,
      updatedAt: now,
    });

    const res = await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "gh-del-1");
    expect(res.status).toBe(204);

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].service).toBe("github");
    expect(eventRows[0].eventKey).toBe("github.pull_request.opened");
    expect(eventRows[0].dedupeKey).toBe("gh-del-1");

    const deliveryRows = await api.providers.db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.eventId, eventRows[0].id));
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0].subscriptionId).toBe("sub_gh");
    // Ingest nudges the in-process dispatcher fire-and-forget
    // (`events/ingest.ts` calls `deps.onIngest?.()` outside the transaction),
    // so the row is "pending" only until the dispatcher wins the race. What
    // this case pins is that ingest MATCHED the subscription and wrote one
    // delivery for it; the terminal status is the dispatcher's own suite
    // (`events/dispatcher.test.ts`). Asserting "pending" here made the case
    // fail whenever delivery landed first.
    expect(["pending", "delivered"]).toContain(deliveryRows[0].status);
  });

  it("drops forwarded events with no matching subscription (nothing stored)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);

    const res = await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "gh-del-2");
    // The route still acks (204): the event verified, it just matched no
    // subscription. Ingest is match-gated for privacy, so an unsubscribed
    // event is dropped and never persisted.
    expect(res.status).toBe(204);

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(0);
  });

  it("dedupes a redelivered webhook (same x-github-delivery -> one events row, one delivery)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow();

    const now = Date.now();
    await api.providers.db.insert(eventSubscriptions).values({
      id: "sub_gh",
      orgId: "local-org",
      ownerType: "org",
      ownerId: "local-org",
      name: "PR opened",
      eventKeys: ["github.pull_request.opened"],
      filters: [],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: "local-user",
      createdAt: now,
      updatedAt: now,
    });

    const first = await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "gh-del-3");
    expect(first.status).toBe(204);
    const second = await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "gh-del-3");
    expect(second.status).toBe(204);

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(1);
    const deliveryRows = await api.providers.db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.eventId, eventRows[0].id));
    expect(deliveryRows).toHaveLength(1);
  });

  it("routes by installation row and verifies with the env secret when only the env fallback is configured", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    setEnvApp();
    useFixture();
    await api.providers.db.insert(githubInstallations).values({
      id: "ghi_env",
      orgId: "local-org",
      installationId: 999,
      accountLogin: "acme",
      accountId: githubAccountId("acme"),
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const payload = { action: "suspend", installation: { id: 999, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const badSig = signWebhookBody(JSON.stringify(payload), "wrong-secret");
    expect((await postWebhook(api.baseUrl, "installation", payload, badSig)).status).toBe(403);

    const sig = signWebhookBody(JSON.stringify(payload), ENV_APP.GITHUB_APP_WEBHOOK_SECRET);
    expect((await postWebhook(api.baseUrl, "installation", payload, sig)).status).toBe(204);

    const [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_env"));
    expect(row.suspended).toBe(true);
  });

  it("routes to the deployment's org when the env fallback has no matching installation row yet", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    setEnvApp();
    useFixture({
      listInstallations: () => ({
        body: [{ id: 555, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });

    const payload = { action: "created", installation: { id: 555, account: { id: githubAccountId("acme"), login: "acme", type: "Organization" } } };
    const sig = signWebhookBody(JSON.stringify(payload), ENV_APP.GITHUB_APP_WEBHOOK_SECRET);
    expect((await postWebhook(api.baseUrl, "installation", payload, sig)).status).toBe(204);

    const rows = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, "local-org"));
    expect(rows.some((r) => r.accountLogin === "acme")).toBe(true);
  });

  it("413s a body over the 1 MiB cap", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await setupConfiguredOrg(api.baseUrl);
    const big = "a".repeat(1_048_577);
    const res = await fetch(`${api.baseUrl}/webhooks/github-app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": "sha256=irrelevant",
        "content-length": String(big.length),
      },
      body: big,
    });
    expect(res.status).toBe(413);
  });
});
