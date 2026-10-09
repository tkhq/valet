/**
 * The organization Linear connection, served by the Linear plugin through the
 * host route mount. Route-level: real Hono app via `bootTestApi`, real HTTP
 * requests, a fake Linear API server (`startLinearFixture`) subbed in via
 * `LINEAR_API_URL`.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import linearPlugin from "@valet/plugin-linear/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startLinearFixture, type LinearFixture, type LinearFixtureCall } from "../test-helpers/linear-fixture.js";
import { credentials, linearInstallations, orgMembers } from "../schema/index.js";
import { linearConnectionAdapter } from "./http-linear-connection.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
const APP = { clientId: "lin-client-id", clientSecret: "lin-client-secret", webhookSecret: "lin-webhook-secret" };
const ORG = { type: "org" as const, id: "local-org" };
const CANONICAL = "/api/plugins/linear/http/connection";
const ROUTES = [
  { name: "canonical route", path: CANONICAL },
] as const;

let api: TestApi | undefined;
let fixture: LinearFixture | undefined;

const SAVED_ENV_KEYS = ["LINEAR_API_URL", "VALET_PUBLIC_URL"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(
  SAVED_ENV_KEYS.map((k) => [k, process.env[k]]),
);

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function boot(opts: Parameters<typeof bootTestApi>[0] = {}): Promise<TestApi> {
  return bootTestApi({ plugins: [linearPlugin], ...opts });
}

function useFixture(overrides: Parameters<typeof startLinearFixture>[0] = {}): LinearFixture {
  fixture = startLinearFixture(overrides);
  process.env.LINEAR_API_URL = fixture.url;
  return fixture;
}

function tokenCalls(f: LinearFixture, grant: string): LinearFixtureCall[] {
  return f.calls.filter((call) => call.path === "/oauth/token" && (call.body as Record<string, string>).grant_type === grant);
}

describe.each(ROUTES)("Linear connection through the $name", ({ path }) => {
  const url = (target: TestApi) => `${target.baseUrl}${path}`;
  const saveApp = (target: TestApi, body: Record<string, unknown> = APP, headers: Record<string, string> = HEADERS) =>
    fetch(url(target), { method: "PUT", headers, body: JSON.stringify(body) });
  const status = async (target: TestApi): Promise<Record<string, unknown>> =>
    (await fetch(url(target), { headers: HEADERS })).json() as Promise<Record<string, unknown>>;

  describe("PUT", () => {
    it("403s for a non-admin org member", async () => {
      api = await boot();
      const f = useFixture();
      expect((await saveApp(api, APP, MEMBER_HEADERS)).status).toBe(403);
      expect(f.calls).toHaveLength(0);
    });

    it("400s unless all three values are present", async () => {
      api = await boot();
      const f = useFixture();
      for (const missing of ["clientId", "clientSecret", "webhookSecret"]) {
        const res = await saveApp(api, { ...APP, [missing]: " " });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("webhook signing secret");
      }
      expect(f.calls).toHaveLength(0);
    });

    it("rejects malformed and oversized bodies before it calls Linear or stores anything", async () => {
      api = await boot();
      const f = useFixture();
      const malformed = await fetch(url(api), { method: "PUT", headers: HEADERS, body: "{not json" });
      expect(malformed.status).toBe(400);
      const oversized = await fetch(url(api), {
        method: "PUT", headers: HEADERS, body: JSON.stringify({ ...APP, padding: "x".repeat(1024 * 1024) }),
      });
      expect(oversized.status).toBe(413);
      expect(f.calls).toHaveLength(0);
      expect(await api.providers.db.select().from(credentials)).toHaveLength(0);
      expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(0);
    });

    it("verifies with a client_credentials token, then stores the app, token, secret, and installation", async () => {
      api = await boot();
      const f = useFixture();
      const res = await saveApp(api);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ configured: true, clientId: "lin-client-id", connected: true, webhookConfigured: true, ready: true, workspaceName: "Turnkey" });

      const [grant] = tokenCalls(f, "client_credentials");
      expect(grant.body).toMatchObject({ client_id: "lin-client-id", client_secret: "lin-client-secret", scope: "read,write" });
      const [lookup] = f.calls.filter((call) => call.path === "/graphql");
      expect(lookup.authHeader).toBe("Bearer lin_app_token");

      const cred = await api.providers.engineCredentials.get(ORG, "linear");
      expect(cred).toMatchObject({
        type: "oauth2",
        accessToken: "lin_app_token",
        metadata: { webhookSecret: "lin-webhook-secret", workspaceId: "lin-org-1", grant: "client_credentials" },
      });
      expect(cred?.metadata?.tokenExpiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
      const app = await api.providers.engineCredentials.get(ORG, "linear_app");
      expect(app).toMatchObject({ apiKey: "lin-client-secret", metadata: { clientId: "lin-client-id" } });
      // One connection ID fences token renewal against a concurrent reconnect.
      expect(typeof app?.metadata?.connectionId).toBe("string");
      expect(cred?.metadata?.connectionId).toBe(app?.metadata?.connectionId);
      const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ workspaceId: "lin-org-1", workspaceName: "Turnkey", webhookId: null, connectedBy: "local-user" });
    });

    it("binds storage to the authenticated organization, not an orgId in the body", async () => {
      api = await boot();
      useFixture();
      expect((await saveApp(api, { ...APP, orgId: "foreign", userId: "foreign-user" })).status).toBe(200);
      const owners = await api.providers.db.select({ ownerType: credentials.ownerType, ownerId: credentials.ownerId, service: credentials.service })
        .from(credentials);
      expect(owners).toEqual(expect.arrayContaining([
        { ownerType: "org", ownerId: "local-org", service: "linear" },
        { ownerType: "org", ownerId: "local-org", service: "linear_app" },
      ]));
      expect(owners).toHaveLength(2);
      const rows = await api.providers.db.select().from(linearInstallations);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ orgId: "local-org", connectedBy: "local-user" });
    });

    it("replaces the connection ID on reconnect and keeps one installation", async () => {
      api = await boot();
      useFixture();
      await saveApp(api);
      const first = await api.providers.engineCredentials.get(ORG, "linear_app");
      expect((await saveApp(api)).status).toBe(200);
      const app = await api.providers.engineCredentials.get(ORG, "linear_app");
      const token = await api.providers.engineCredentials.get(ORG, "linear");
      expect(app?.metadata?.connectionId).not.toBe(first?.metadata?.connectionId);
      expect(token?.metadata?.connectionId).toBe(app?.metadata?.connectionId);
      expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(1);
    });

    it("stores nothing and names the fix when Linear refuses the client_credentials grant", async () => {
      api = await boot();
      useFixture({ oauthToken: () => ({ status: 400, body: { error: "unsupported_grant_type", error_description: "Client does not support the client_credentials grant type" } }) });
      const res = await saveApp(api);
      expect(res.status).toBe(400);
      const error = ((await res.json()) as { error: string }).error;
      expect(error).toContain("turn on Client credentials");
      expect(error).toContain("Linear said: Client does not support the client_credentials grant type");
      expect(await api.providers.engineCredentials.get(ORG, "linear")).toBeNull();
      expect(await api.providers.engineCredentials.get(ORG, "linear_app")).toBeNull();
      expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(0);
    });

    it("names the credentials when Linear rejects the client ID or secret", async () => {
      api = await boot();
      useFixture({ oauthToken: () => ({ status: 401, body: { error: "invalid_client" } }) });
      const res = await saveApp(api);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("Copy the client ID and client secret again");
    });

    it("502s and stores nothing when the workspace lookup fails", async () => {
      api = await boot();
      useFixture({ organization: () => ({ status: 500, body: { errors: [{ message: "boom" }] } }) });
      const res = await saveApp(api);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain("workspace lookup failed");
      expect(await api.providers.engineCredentials.get(ORG, "linear")).toBeNull();
    });

    it("409s when a different Linear workspace is already connected", async () => {
      api = await boot();
      useFixture();
      await api.providers.db.insert(linearInstallations).values({
        id: "lin_pre-existing", orgId: "local-org", workspaceId: "lin-org-OTHER", workspaceName: "Other Workspace",
        webhookId: null, connectedBy: "local-user", createdAt: Date.now(), updatedAt: Date.now(),
      });
      const res = await saveApp(api);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("Other Workspace");
      expect(await api.providers.engineCredentials.get(ORG, "linear")).toBeNull();
    });
  });

  describe("GET", () => {
    it("403s for a non-admin org member", async () => {
      api = await boot();
      expect((await fetch(url(api), { headers: MEMBER_HEADERS })).status).toBe(403);
    });

    it("reports setup inputs and never returns secrets", async () => {
      api = await boot();
      useFixture();
      const before = await status(api);
      expect(before).toMatchObject({ configured: false, connected: false, ready: false, redirectUri: `${api.baseUrl}/api/org/linear/callback` });
      expect(before.webhookUrl).toBeUndefined();
      expect(before.webhookResourceTypes).toEqual(["Issue", "Comment", "Project", "Cycle", "IssueLabel", "Reaction"]);
      await saveApp(api);
      const after = JSON.stringify(await status(api));
      for (const secret of ["lin-client-secret", "lin-webhook-secret", "lin_app_token"]) expect(after).not.toContain(secret);
    });

    it("offers the public HTTPS event URL for the app webhook", async () => {
      process.env.VALET_PUBLIC_URL = "https://valet.example";
      api = await boot();
      expect(await status(api)).toMatchObject({
        webhookUrl: "https://valet.example/webhooks/events/linear",
        redirectUri: "https://valet.example/api/org/linear/callback",
      });
    });
  });

  describe("DELETE", () => {
    it("403s for a non-admin org member", async () => {
      api = await boot();
      expect((await fetch(url(api), { method: "DELETE", headers: MEMBER_HEADERS })).status).toBe(403);
    });

    it("removes the installation, token, and app", async () => {
      api = await boot();
      useFixture();
      await saveApp(api);
      expect((await fetch(url(api), { method: "DELETE", headers: HEADERS })).status).toBe(204);
      expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(0);
      expect(await api.providers.engineCredentials.get(ORG, "linear")).toBeNull();
      expect(await api.providers.engineCredentials.get(ORG, "linear_app")).toBeNull();
      expect(await status(api)).toMatchObject({ configured: false, connected: false, ready: false });
    });

    it("removes a webhook an older connection created, and still disconnects when that fails", async () => {
      for (const ok of [true, false]) {
        api = await boot();
        const f = useFixture(ok ? {} : { webhookDelete: () => ({ status: 500, body: { errors: [{ message: "boom" }] } }) });
        await saveApp(api);
        await api.providers.db.update(linearInstallations).set({ webhookId: "wh-legacy" }).where(eq(linearInstallations.orgId, "local-org"));
        expect((await fetch(url(api), { method: "DELETE", headers: HEADERS })).status).toBe(204);
        const [deleteCall] = f.calls.filter((call) => JSON.stringify(call.body ?? "").includes("webhookDelete"));
        expect((deleteCall.body as { variables: { id: string } }).variables.id).toBe("wh-legacy");
        expect(deleteCall.authHeader).toBe("Bearer lin_app_token");
        expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(0);
        await api.cleanup(); api = undefined;
        await f.close(); fixture = undefined;
      }
    });

    it("refuses a request body and keeps the connection", async () => {
      api = await boot();
      useFixture();
      await saveApp(api);
      expect((await fetch(url(api), { method: "DELETE", headers: HEADERS, body: "{}" })).status).toBe(413);
      expect(await api.providers.engineCredentials.get(ORG, "linear")).not.toBeNull();
      expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(1);
    });
  });
});

describe("Linear connection adapter binding", () => {
  // Pass-through spy: the host must not build the adapter for a refused caller.
  const capability = vi.spyOn(linearConnectionAdapter, "create");
  afterAll(() => capability.mockRestore());

  it("builds the adapter only after identity, membership, administration, and body checks pass", async () => {
    api = await boot();
    const f = useFixture();
    capability.mockClear();
    for (const path of [CANONICAL]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await fetch(`${api.baseUrl}${path}`, { method, headers: MEMBER_HEADERS, ...(method === "PUT" ? { body: JSON.stringify(APP) } : {}) });
        expect(res.status).toBe(403);
      }
      const oversized = await fetch(`${api.baseUrl}${path}`, { method: "PUT", headers: HEADERS, body: "x".repeat(1024 * 1024 + 1) });
      expect(oversized.status).toBe(413);
    }
    await api.providers.db.delete(orgMembers).where(eq(orgMembers.userId, "local-user"));
    for (const path of [CANONICAL]) {
      expect((await fetch(`${api.baseUrl}${path}`, { headers: HEADERS })).status).toBe(403);
    }
    expect(capability).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it("refuses anonymous callers before it builds the adapter", async () => {
    api = await boot({ auth: true });
    capability.mockClear();
    for (const path of [CANONICAL]) {
      expect((await fetch(`${api.baseUrl}${path}`, { headers: HEADERS })).status).toBe(401);
    }
    expect(capability).not.toHaveBeenCalled();
  });

  it("binds the adapter to the host caller for an administrator", async () => {
    api = await boot();
    capability.mockClear();
    expect((await fetch(`${api.baseUrl}${CANONICAL}`, { headers: { ...HEADERS, "x-valet-test-user-id": "local-user" } })).status).toBe(200);
    expect(capability).toHaveBeenCalledOnce();
    expect(capability.mock.calls[0][1]).toEqual({ userId: "local-user", orgId: "local-org" });
  });
});
