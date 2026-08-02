/**
 * `/api/org/github-app` admin routes + PUBLIC `/webhooks/github-app` sync
 * (GitHub/repo integration plan, Task 5). Route-level: real Hono app via
 * `bootTestApi`, real HTTP requests, a fake GitHub API server
 * (`startGithubFixture`) subbed in via `GITHUB_API_URL` for the duration of
 * tests that need `discoverInstallations` to actually call out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { eventDeliveries, events, eventSubscriptions, githubInstallations } from "../schema/index.js";
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

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
  if (prevValetPublicUrl === undefined) delete process.env.VALET_PUBLIC_URL;
  else process.env.VALET_PUBLIC_URL = prevValetPublicUrl;
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
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
  });

  it("reports unconfigured with an empty installations list and manual webhook mode", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body).toEqual({ configured: false, installations: [], webhook: { mode: "manual" } });
  });

  it("reports public webhook mode when VALET_PUBLIC_URL is set", async () => {
    api = await bootTestApi();
    process.env.VALET_PUBLIC_URL = "https://valet.example.com";
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.webhook.mode).toBe("public");
  });
});

describe("POST /api/org/github-app/manifest", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("builds a manual-mode manifest (no VALET_PUBLIC_URL): empty default_events, inactive placeholder hook", async () => {
    api = await bootTestApi();
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
    expect(body.manifest.public).toBe(false);
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
    api = await bootTestApi();
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
    // installation sync events + every ingestable trigger family (no ping —
    // GitHub sends it unconditionally on webhook creation).
    expect(body.manifest.default_events.slice(0, 2)).toEqual(["installation", "installation_repositories"]);
    const triggerFamilies = githubPlugin.triggers!.map((t) => t.id.slice("github.".length));
    expect(body.manifest.default_events.slice(2).sort()).toEqual(
      triggerFamilies.filter((e) => e !== "ping").sort(),
    );
    expect(body.manifest.default_events).not.toContain("ping");
    expect(body.manifest.hook_attributes).toEqual({ url: "https://valet.example.com/webhooks/github-app" });
  });

  it("routes an org target to the organization app-creation URL", async () => {
    api = await bootTestApi();
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
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/github-app/setup?code=abc`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("400s on a tampered state", async () => {
    api = await bootTestApi();
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
    api = await bootTestApi();
    useFixture({ convertManifest: () => ({ status: 404, body: { message: "not found" } }) });
    const state = await fetchManifestState(api.baseUrl);
    const res = await fetch(
      `${api.baseUrl}/api/org/github-app/setup?code=bad-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(409);
  });

  it("502s when GitHub's conversion endpoint 5xxs", async () => {
    api = await bootTestApi();
    useFixture({ convertManifest: () => ({ status: 503, body: { message: "unavailable" } }) });
    const state = await fetchManifestState(api.baseUrl);
    const res = await fetch(
      `${api.baseUrl}/api/org/github-app/setup?code=bad-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(502);
  });

  it("exchanges the code, saves the app config with no secrets ever surfaced, and runs discovery", async () => {
    api = await bootTestApi();
    const { fixture: f } = await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({
        body: [{ id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
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
    api = await bootTestApi();
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

describe("POST /api/org/github-app/refresh", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/github-app/refresh`, { method: "POST", headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("re-runs discovery and returns the refreshed list", async () => {
    api = await bootTestApi();
    let installations: unknown[] = [];
    await setupConfiguredOrg(api.baseUrl, { listInstallations: () => ({ body: installations }) });

    installations = [{ id: 222, account: { login: "beta", type: "User" }, repository_selection: "selected", suspended_at: null }];
    const res = await fetch(`${api.baseUrl}/api/org/github-app/refresh`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetGithubAppResponse;
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0].accountLogin).toBe("beta");
  });
});

describe("DELETE /api/org/github-app", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/github-app`, { method: "DELETE", headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("removes the config and every installation row, degrading gracefully (no refusal)", async () => {
    api = await bootTestApi();
    await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({
        body: [{ id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/org/github-app`, { method: "DELETE", headers: HEADERS });
    expect(delRes.status).toBe(204);

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await getRes.json()) as GetGithubAppResponse;
    expect(body).toEqual({ configured: false, installations: [], webhook: { mode: "manual" } });
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
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }

  it("403s on a bad signature", async () => {
    api = await bootTestApi();
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    const payload = { action: "suspend", installation: { id: 999, account: { login: "acme", type: "Organization" } } };
    const badSig = signWebhookBody(JSON.stringify(payload), `${webhookSecret}-wrong`);
    const res = await postWebhook(api.baseUrl, "installation", payload, badSig);
    expect(res.status).toBe(403);
  });

  it("403s with no signature header at all", async () => {
    api = await bootTestApi();
    await setupConfiguredOrg(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/webhooks/github-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-github-event": "installation" },
      body: JSON.stringify({ action: "suspend", installation: { id: 999 } }),
    });
    expect(res.status).toBe(403);
  });

  it("204s and ignores unknown event types", async () => {
    api = await bootTestApi();
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    const payload = { hello: "world" };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "star", payload, sig);
    expect(res.status).toBe(204);
  });

  it("flips suspended=true on installation.suspend, suspended=false on installation.unsuspend", async () => {
    api = await bootTestApi();
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow();

    const suspendPayload = { action: "suspend", installation: { id: 999, account: { login: "acme", type: "Organization" } } };
    const suspendSig = signWebhookBody(JSON.stringify(suspendPayload), webhookSecret);
    const suspendRes = await postWebhook(api.baseUrl, "installation", suspendPayload, suspendSig);
    expect(suspendRes.status).toBe(204);

    let [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(row.suspended).toBe(true);

    const unsuspendPayload = { action: "unsuspend", installation: { id: 999, account: { login: "acme", type: "Organization" } } };
    const unsuspendSig = signWebhookBody(JSON.stringify(unsuspendPayload), webhookSecret);
    const unsuspendRes = await postWebhook(api.baseUrl, "installation", unsuspendPayload, unsuspendSig);
    expect(unsuspendRes.status).toBe(204);

    [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(row.suspended).toBe(false);
  });

  it("removes the row on installation.deleted", async () => {
    api = await bootTestApi();
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow();

    const payload = { action: "deleted", installation: { id: 999, account: { login: "acme", type: "Organization" } } };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "installation", payload, sig);
    expect(res.status).toBe(204);

    const rows = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(rows).toHaveLength(0);
  });

  it("re-derives repositorySelection and touches updatedAt on installation_repositories", async () => {
    api = await bootTestApi();
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);
    await seedInstallationRow({ repositorySelection: "all", updatedAt: 1_000 });

    const payload = {
      action: "added",
      repository_selection: "selected",
      installation: { id: 999, account: { login: "acme", type: "Organization" } },
    };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "installation_repositories", payload, sig);
    expect(res.status).toBe(204);

    const [row] = await api.providers.db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_seed"));
    expect(row.repositorySelection).toBe("selected");
    expect(row.updatedAt).toBeGreaterThan(1_000);
  });

  it("upserts a new row via discovery on installation.created", async () => {
    api = await bootTestApi();
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl, {
      listInstallations: () => ({
        body: [{ id: 555, account: { login: "newco", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
    });

    const payload = { action: "created", installation: { id: 555, account: { login: "newco", type: "Organization" } } };
    const sig = signWebhookBody(JSON.stringify(payload), webhookSecret);
    const res = await postWebhook(api.baseUrl, "installation", payload, sig);
    expect(res.status).toBe(204);

    const getRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const body = (await getRes.json()) as GetGithubAppResponse;
    expect(body.installations.some((i) => i.accountLogin === "newco")).toBe(true);
  });

  it("204s with no app configured anywhere", async () => {
    api = await bootTestApi();
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
    action: "opened",
    pull_request: { number: 7, title: "Add thing" },
    repository: { full_name: "acme/widgets" },
    sender: { id: 1234, login: "octocat" },
  };

  it("forwards a pull_request webhook into the event pipeline: events row + matched pending delivery", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);

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
    expect(deliveryRows[0].status).toBe("pending");
    expect(deliveryRows[0].subscriptionId).toBe("sub_gh");
  });

  it("ingests forwarded events with no matching subscription (event row, zero deliveries)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);

    const res = await postForwardedWebhook(api.baseUrl, "pull_request", PR_OPENED_PAYLOAD, webhookSecret, "gh-del-2");
    expect(res.status).toBe(204);

    const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
    expect(eventRows).toHaveLength(1);
    const deliveryRows = await api.providers.db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.eventId, eventRows[0].id));
    expect(deliveryRows).toHaveLength(0);
  });

  it("dedupes a redelivered webhook (same x-github-delivery -> one events row, one delivery)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const { webhookSecret } = await setupConfiguredOrg(api.baseUrl);

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

  it("413s a body over the 1 MiB cap", async () => {
    api = await bootTestApi();
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
