/**
 * Route parity for the GitHub HTTP surface. Each case runs against the legacy
 * URL and the canonical plugin URL, so both answer with the same status and
 * body. The deeper behavior suites (`github-app.test.ts`,
 * `github-connect.test.ts`) exercise the legacy URLs only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { resetGithubAppVisibilityCache } from "../services/github-app-visibility.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { credentials, githubInstallations } from "../schema/index.js";
import type { GetGithubAppResponse, GetGithubOrgStatusResponse, PostGithubConnectResponse } from "../wire/types.js";

const ADMIN = { "Content-Type": "application/json" };
const MEMBER = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

const { privateKey: TEST_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ENV_APP: Record<string, string> = {
  GITHUB_APP_ID: "777",
  GITHUB_APP_SLUG: "valet-env",
  GITHUB_APP_CLIENT_ID: "Iv1.envclient",
  GITHUB_APP_CLIENT_SECRET: "env-oauth-secret",
  GITHUB_APP_WEBHOOK_SECRET: "env-hook-secret",
  GITHUB_APP_PRIVATE_KEY: TEST_PEM,
};
const SAVED_ENV = Object.fromEntries(
  [...Object.keys(ENV_APP), "GITHUB_API_URL", "GITHUB_URL", "VALET_PUBLIC_URL"].map((name) => [name, process.env[name]]),
);

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  resetGithubAppVisibilityCache();
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function useFixture(overrides: Parameters<typeof startGithubFixture>[0] = {}): GithubFixture {
  fixture = startGithubFixture(overrides);
  process.env.GITHUB_API_URL = fixture.url;
  process.env.GITHUB_URL = fixture.url;
  return fixture;
}

type RouteId =
  | "app-status" | "app-manifest" | "app-setup" | "app-credential" | "app-refresh" | "app-disconnect"
  | "connect" | "org-status" | "callback" | "disconnect" | "webhook";

const LEGACY: Record<RouteId, string> = {
  "app-status": "/api/org/github-app",
  "app-manifest": "/api/org/github-app/manifest",
  "app-setup": "/api/org/github-app/setup",
  "app-credential": "/api/org/github-app/credential",
  "app-refresh": "/api/org/github-app/refresh",
  "app-disconnect": "/api/org/github-app",
  connect: "/api/me/github/connect",
  "org-status": "/api/me/github/org-status",
  callback: "/api/me/github/callback",
  disconnect: "/api/me/github",
  webhook: "/webhooks/github-app",
};

const CANONICAL: Record<RouteId, string> = {
  "app-status": "/api/plugins/github/http/app",
  "app-manifest": "/api/plugins/github/http/app/manifest",
  "app-setup": "/api/plugins/github/http/app/setup",
  "app-credential": "/api/plugins/github/http/app/credential",
  "app-refresh": "/api/plugins/github/http/app/refresh",
  "app-disconnect": "/api/plugins/github/http/app",
  connect: "/api/plugins/github/http/connection/connect",
  "org-status": "/api/plugins/github/http/connection/org-status",
  callback: "/api/plugins/github/http/connection/callback",
  disconnect: "/api/plugins/github/http/connection",
  webhook: "/plugins/github/http/webhook",
};

const SURFACES = [
  { name: "legacy", url: LEGACY },
  { name: "canonical", url: CANONICAL },
] as const;

function sign(body: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe.each(SURFACES)("$name GitHub routes", ({ url }) => {
  async function call(id: RouteId, init: RequestInit = {}, query = ""): Promise<{ status: number; body: unknown }> {
    if (!api) throw new Error("Boot the test API first.");
    const response = await fetch(`${api.baseUrl}${url[id]}${query}`, { redirect: "manual", ...init });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  it("answers org-admin routes with the same refusals and reads", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    expect(await call("app-status", { headers: MEMBER })).toEqual({ status: 403, body: { error: "org admin required" } });
    expect(await call("app-status", { headers: ADMIN })).toEqual({
      status: 200,
      body: { configured: false, installations: [], webhook: { mode: "manual" }, installationsCheckedAt: null },
    });
    expect(await call("app-manifest", { method: "POST", headers: MEMBER, body: "{}" })).toEqual({
      status: 403, body: { error: "org admin required" },
    });
    expect(await call("app-manifest", { method: "POST", headers: ADMIN, body: JSON.stringify({ permissions: { contents: "owner" } }) })).toEqual({
      status: 400, body: { error: 'invalid permission "contents"="owner" — levels are read/write/admin' },
    });
    expect(await call("app-manifest", { method: "POST", headers: ADMIN, body: JSON.stringify({ events: ["Push"] }) })).toEqual({
      status: 400, body: { error: "events must be an array of snake_case event names" },
    });
    expect(await call("app-credential", { method: "POST", headers: ADMIN, body: "not json" })).toEqual({
      status: 400, body: { error: "Send a JSON body with the app id and the private key." },
    });
    expect(await call("app-credential", { method: "POST", headers: ADMIN, body: JSON.stringify({ appId: "1", privateKey: "nope" }) })).toEqual({
      status: 400,
      body: { error: "The private key is not a PEM. Paste the whole file GitHub downloaded, including the BEGIN and END lines." },
    });
    expect(await call("app-refresh", { method: "POST", headers: MEMBER })).toEqual({ status: 403, body: { error: "org admin required" } });
    expect(await call("app-disconnect", { method: "DELETE", headers: MEMBER })).toEqual({ status: 403, body: { error: "org admin required" } });
    expect(await call("app-disconnect", { method: "DELETE", headers: ADMIN })).toEqual({ status: 204, body: null });
  });

  it("answers user routes with the same reads and refusals", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    expect(await call("org-status", { headers: MEMBER })).toEqual({
      status: 200, body: { configured: false, installationCount: 0, suspendedCount: 0 },
    });
    expect(await call("connect", { method: "POST", headers: MEMBER })).toEqual({
      status: 409, body: { error: "no GitHub App is configured for this organization; ask an admin to set it up first" },
    });
    expect(await call("callback", { headers: MEMBER })).toEqual({ status: 400, body: { error: "missing code or state" } });
    expect(await call("callback", { headers: MEMBER }, "?code=c&state=forged.state")).toEqual({
      status: 400, body: { error: "invalid or expired state" },
    });
    expect(await call("app-setup", { headers: MEMBER }, "?code=c")).toEqual({ status: 400, body: { error: "missing code or state" } });
    expect(await call("disconnect", { method: "DELETE", headers: MEMBER })).toEqual({ status: 204, body: null });
  });

  // GitHub installs a private App only on the account that owns it. Its
  // `/installations/new` page then lists only that owner, so a member who
  // follows the link cannot pick a personal account.
  describe("personal install link", () => {
    const BASE = { configured: true, installationCount: 0, suspendedCount: 0 };

    it("gives no link for a private App, and says why", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      const f = useFixture({ getAppBySlug: () => ({ status: 404, body: { message: "Not Found" } }) });
      expect(await call("org-status", { headers: MEMBER })).toEqual({
        status: 200, body: { ...BASE, personalInstallBlocked: "app_private" },
      });
      // GitHub answers this read without authentication only for a public
      // App, so the check must not send a credential.
      const probe = f.calls.find((c) => c.path === "/apps/valet-env");
      expect(probe).toMatchObject({ method: "GET", authHeader: undefined });
    });

    it("links a public App's installation page for a member who connected GitHub", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      const f = useFixture();
      expect(await call("org-status", { headers: MEMBER })).toEqual({
        status: 200, body: { ...BASE, personalInstallBlocked: "github_not_connected" },
      });
      await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
        type: "oauth2", accessToken: "member-token", metadata: { login: "member", githubId: "4242", githubHost: f.url },
      });
      expect(await call("org-status", { headers: MEMBER })).toEqual({
        status: 200, body: { ...BASE, personalInstallUrl: `${f.url}/apps/valet-env/installations/new` },
      });
    });

    it("gives no link when GitHub cannot say whether the App is public", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      useFixture({ getAppBySlug: () => ({ status: 503, body: { message: "unavailable" } }) });
      expect(await call("org-status", { headers: MEMBER })).toEqual({
        status: 200, body: { ...BASE, personalInstallBlocked: "app_visibility_unknown" },
      });
    });
  });

  it("refuses unauthenticated callers on every authenticated route", async () => {
    api = await bootTestApi({ plugins: [githubPlugin], auth: true });
    const ids: Array<[RouteId, string]> = [
      ["app-status", "GET"], ["app-manifest", "POST"], ["app-setup", "GET"], ["app-credential", "POST"],
      ["app-refresh", "POST"], ["app-disconnect", "DELETE"], ["connect", "POST"], ["org-status", "GET"],
      ["callback", "GET"], ["disconnect", "DELETE"],
    ];
    for (const [id, method] of ids) {
      expect({ id, status: (await call(id, { method })).status }).toEqual({ id, status: 401 });
    }
  });

  it("binds a pasted credential to the caller's organization, not one named in the body", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({
      getApp: () => ({ body: { id: 4242, slug: "existing-app", client_id: "Iv1.existing", html_url: "https://github.com/apps/existing-app" } }),
      listInstallations: () => ({ body: [] }),
    });
    const response = await call("app-credential", {
      method: "POST", headers: ADMIN,
      body: JSON.stringify({ appId: "4242", privateKey: TEST_PEM, orgId: "foreign", userId: "test-member" }),
    });
    expect(response.status).toBe(200);
    const rows = await api.providers.db.select({ ownerId: credentials.ownerId }).from(credentials)
      .where(and(eq(credentials.ownerType, "org"), eq(credentials.service, "github_app")));
    expect(rows).toEqual([{ ownerId: "local-org" }]);
  });

  it("reaches no capability for a non-admin or an oversized body", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const f = useFixture({ getApp: () => ({ body: { id: 4242, slug: "existing-app" } }) });
    const body = JSON.stringify({ appId: "4242", privateKey: TEST_PEM });
    expect((await call("app-credential", { method: "POST", headers: MEMBER, body })).status).toBe(403);
    expect((await call("app-credential", { method: "POST", headers: ADMIN, body: JSON.stringify({ appId: "4242", privateKey: TEST_PEM, pad: "x".repeat(64 * 1024) }) })))
      .toEqual({ status: 413, body: { error: "payload too large" } });
    expect(f.calls).toEqual([]);
    const rows = await api.providers.db.select({ ownerId: credentials.ownerId }).from(credentials)
      .where(eq(credentials.service, "github_app"));
    expect(rows).toEqual([]);
  });

  it("refuses a connect state minted for another user without calling GitHub", async () => {
    Object.assign(process.env, ENV_APP);
    api = await bootTestApi({ plugins: [githubPlugin] });
    const f = useFixture();
    const started = await call("connect", { method: "POST", headers: ADMIN });
    expect(started.status).toBe(200);
    const body = started.body as PostGithubConnectResponse;
    const state = new URL(body.url).searchParams.get("state") ?? "";
    expect(await call("callback", { headers: MEMBER }, `?code=c&state=${encodeURIComponent(state)}`)).toEqual({
      status: 400, body: { error: "this authorization was not started by the signed-in user" },
    });
    expect(f.calls).toEqual([]);
    const saved = await api.providers.db.select({ ownerId: credentials.ownerId }).from(credentials)
      .where(and(eq(credentials.ownerType, "user"), eq(credentials.service, "github")));
    expect(saved).toEqual([]);
  });

  it("refuses a forged setup state without calling GitHub", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const f = useFixture();
    const forged = `${Buffer.from(JSON.stringify({ orgId: "local-org", nonce: "n", exp: Date.now() + 60_000 })).toString("base64url")}.bad`;
    expect(await call("app-setup", { headers: ADMIN }, `?code=c&state=${encodeURIComponent(forged)}`)).toEqual({
      status: 400, body: { error: "invalid or expired state" },
    });
    expect(f.calls).toEqual([]);
  });

  describe("webhook", () => {
    async function seedInstallation(): Promise<void> {
      const now = Date.now();
      await api!.providers.db.insert(githubInstallations).values({
        id: "ghi_parity", orgId: "local-org", installationId: 999, accountLogin: "acme",
        accountType: "Organization", repositorySelection: "all", suspended: false, createdAt: now, updatedAt: now,
      });
    }

    async function deliver(body: string | Uint8Array, headers: Record<string, string>) {
      return call("webhook", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    }

    it("acknowledges with 204 when no App is configured anywhere", async () => {
      api = await bootTestApi({ plugins: [githubPlugin] });
      expect(await deliver("{}", { "x-github-event": "ping" })).toEqual({ status: 204, body: null });
    });

    it("refuses missing and wrong signatures without side effects", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      await seedInstallation();
      const f = useFixture({ listInstallations: () => ({ body: [] }) });
      const deleted = JSON.stringify({ action: "deleted", installation: { id: 999 } });
      const created = JSON.stringify({ action: "created", installation: { id: 999 } });
      const refusal = { status: 403, body: { error: "signature verification failed" } };
      expect(await deliver(deleted, { "x-github-event": "installation" })).toEqual(refusal);
      expect(await deliver(deleted, { "x-github-event": "installation", "x-hub-signature-256": sign(deleted, "wrong") })).toEqual(refusal);
      expect(await deliver(created, { "x-github-event": "installation", "x-hub-signature-256": sign(created, "wrong") })).toEqual(refusal);
      const rows = await api.providers.db.select({ id: githubInstallations.id }).from(githubInstallations);
      expect(rows).toEqual([{ id: "ghi_parity" }]);
      expect(f.calls).toEqual([]);
    });

    it("answers 400 for a signed body that is not JSON", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      expect(await deliver("not json", { "x-github-event": "ping", "x-hub-signature-256": sign("not json", ENV_APP.GITHUB_APP_WEBHOOK_SECRET) })).toEqual({
        status: 400, body: { error: "invalid JSON" },
      });
    });

    it("verifies the exact raw bytes and applies a signed delivery", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      await seedInstallation();
      // Whitespace and key order differ from JSON.stringify output on purpose.
      const raw = '{ "installation": {"id":999},  "action":"suspend" }\n';
      expect(await deliver(raw, { "x-github-event": "installation", "x-hub-signature-256": sign(raw, ENV_APP.GITHUB_APP_WEBHOOK_SECRET) })).toEqual({
        status: 204, body: null,
      });
      const [row] = await api.providers.db.select({ suspended: githubInstallations.suspended }).from(githubInstallations);
      expect(row).toEqual({ suspended: true });
    });

    /** An `installation.created` delivery, shaped as GitHub sends it. */
    function createdDelivery(id: number, account: { login: string; id: number; type: string }, sender: number): string {
      return JSON.stringify({
        action: "created",
        installation: { id, account, repository_selection: "selected", suspended_at: null },
        sender: { id: sender },
      });
    }

    async function deliverSigned(body: string) {
      return deliver(body, { "x-github-event": "installation", "x-hub-signature-256": sign(body, ENV_APP.GITHUB_APP_WEBHOOK_SECRET) });
    }

    it("binds a new personal installation to the member who owns that GitHub account", async () => {
      // A member who connected GitHub follows the personal-install link. The
      // `installation.created` delivery records that one installation and
      // binds it by GitHub account id. A stranger's stays unbound.
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      await seedInstallation();
      const f = useFixture();
      await api.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
        type: "oauth2", accessToken: "member-token", metadata: { login: "member", githubId: "4242", githubHost: f.url },
      });
      expect(await deliverSigned(createdDelivery(8801, { login: "member", id: 4242, type: "User" }, 4242)))
        .toEqual({ status: 204, body: null });
      expect(await deliverSigned(createdDelivery(8802, { login: "stranger", id: 5, type: "User" }, 5)))
        .toEqual({ status: 204, body: null });
      const rows = await api.providers.db
        .select({ installationId: githubInstallations.installationId, linkedUserId: githubInstallations.linkedUserId })
        .from(githubInstallations);
      expect(Object.fromEntries(rows.map((r) => [r.installationId, r.linkedUserId]))).toEqual({
        999: null, 8801: "test-member", 8802: null,
      });
      // A delivery reconciles only its own installation. It never re-reads
      // every installation, so a stranger's install costs one row.
      expect(f.calls.filter((c) => c.path === "/app/installations")).toEqual([]);
    });

    it("approves another organization's installation only when an org admin with a verified connection installed it", async () => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      const f = useFixture();
      // `local-user` is an org admin; `test-member` is not.
      for (const [id, githubId] of [["local-user", "4242"], ["test-member", "4343"]] as const) {
        await api.providers.engineCredentials.save({ type: "user", id }, "github", {
          type: "oauth2", accessToken: `${id}-token`, metadata: { login: id, githubId, githubHost: f.url },
        });
      }
      await deliverSigned(createdDelivery(8803, { login: "admins-org", id: 30, type: "Organization" }, 4242));
      await deliverSigned(createdDelivery(8806, { login: "members-org", id: 32, type: "Organization" }, 4343));
      await deliverSigned(createdDelivery(8804, { login: "strangers-org", id: 31, type: "Organization" }, 5));
      // The App owner's own account serves every member without approval.
      await deliverSigned(createdDelivery(8805, { login: "acme", id: 1, type: "Organization" }, 5));
      const status = await call("app-status", { headers: ADMIN });
      const access = Object.fromEntries(
        (status.body as GetGithubAppResponse).installations.map((i) => [i.installationId, i.access]),
      );
      expect(access).toEqual({ 8803: "organization", 8806: "pending", 8804: "pending", 8805: "organization" });
    });

    it.each([true, false])("refuses a body above 1 MiB (declared length: %s)", async (declared) => {
      Object.assign(process.env, ENV_APP);
      api = await bootTestApi({ plugins: [githubPlugin] });
      const size = 1024 * 1024 + 1;
      const chunk = new Uint8Array(64 * 1024).fill(32);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) { controller.close(); return; }
          const next = chunk.subarray(0, Math.min(chunk.byteLength, size - sent));
          sent += next.byteLength;
          controller.enqueue(next);
        },
      });
      const headers: Record<string, string> = { "Content-Type": "application/json", "x-github-event": "ping" };
      if (declared) headers["content-length"] = String(size);
      // Node requires duplex for a streaming request body.
      const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: stream, duplex: "half" };
      const response = await fetch(`${api.baseUrl}${url.webhook}`, init);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "payload too large" });
    });
  });
});

// Another GitHub organization's installation serves every member only after
// an org admin approves it. The route is new, so it has no legacy URL.
describe("installation approval route", () => {
  const approval = (id: number | string) => `/api/plugins/github/http/app/installations/${id}/approval`;

  async function send(path: string, method: "POST" | "DELETE", headers: Record<string, string>) {
    const response = await fetch(`${api!.baseUrl}${path}`, { method, headers });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  it("lets an org admin approve and revoke another organization's installation", async () => {
    Object.assign(process.env, ENV_APP);
    api = await bootTestApi({ plugins: [githubPlugin] });
    const now = Date.now();
    await api.providers.db.insert(githubInstallations).values([
      { id: "ghi_o", orgId: "local-org", installationId: 777, accountLogin: "stranger-org", accountType: "Organization",
        orgApproved: false, suspended: false, createdAt: now, updatedAt: now },
      { id: "ghi_p", orgId: "local-org", installationId: 888, accountLogin: "someone", accountType: "User", accountId: "5",
        suspended: false, createdAt: now, updatedAt: now },
    ]);
    const orgStatus = async () =>
      (await (await fetch(`${api!.baseUrl}/api/me/github/org-status`, { headers: MEMBER })).json()) as GetGithubOrgStatusResponse;

    expect((await send(approval(777), "POST", MEMBER)).status).toBe(403);
    expect((await orgStatus()).installationCount).toBe(0);

    const approved = await send(approval(777), "POST", ADMIN);
    expect(approved.status).toBe(200);
    const row = (approved.body as GetGithubAppResponse).installations.find((i) => i.installationId === 777);
    expect(row?.access).toBe("organization");
    expect((await orgStatus()).installationCount).toBe(1);

    const revoked = await send(approval(777), "DELETE", ADMIN);
    expect((revoked.body as GetGithubAppResponse).installations.find((i) => i.installationId === 777)?.access).toBe("pending");
    expect((await orgStatus()).installationCount).toBe(0);

    expect(await send(approval(888), "POST", ADMIN)).toEqual({
      status: 400,
      body: { error: "A personal installation serves only the member who owns that GitHub account. It cannot serve the whole organization." },
    });
    expect((await send(approval(12345), "POST", ADMIN)).status).toBe(404);
    expect((await send(approval("abc"), "POST", ADMIN)).status).toBe(400);
  });
});

// A member pasted another person's token, with a made-up refresh token, to
// claim that person's personal installation. Discovery must not bind it:
// only GitHub's token check proves that this App issued a token.
describe("pasted GitHub tokens", () => {
  it("never bind a personal installation", async () => {
    Object.assign(process.env, ENV_APP);
    api = await bootTestApi({ plugins: [githubPlugin] });
    useFixture({
      getUser: () => ({ body: { login: "alice", id: 555 } }),
      listInstallations: () => ({
        body: [
          { id: 999, account: { login: "acme", id: 1, type: "Organization" }, repository_selection: "all", suspended_at: null },
          { id: 5050, account: { login: "alice", id: 555, type: "User" }, repository_selection: "all", suspended_at: null },
        ],
      }),
    });
    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: MEMBER,
      body: JSON.stringify({ type: "oauth2", accessToken: "alices-token", refreshToken: "made-up", metadata: { login: "alice" } }),
    });
    expect(put.status).toBe(200);
    const refresh = await fetch(`${api.baseUrl}/api/org/github-app/refresh`, { method: "POST", headers: ADMIN });
    expect(refresh.status).toBe(200);
    const rows = await api.providers.db
      .select({ installationId: githubInstallations.installationId, linkedUserId: githubInstallations.linkedUserId })
      .from(githubInstallations);
    expect(rows.find((r) => r.installationId === 5050)?.linkedUserId).toBeNull();
  });
});
