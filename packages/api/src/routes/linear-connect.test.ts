/**
 * `/api/org/linear` — the Slack-model Linear connection. Route-level: real
 * Hono app via `bootTestApi`, real HTTP requests, a fake Linear API server
 * (`startLinearFixture`) subbed in via `LINEAR_API_URL`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startLinearFixture, type LinearFixture, type LinearFixtureCall } from "../test-helpers/linear-fixture.js";
import { linearInstallations } from "../schema/index.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
const APP = { clientId: "lin-client-id", clientSecret: "lin-client-secret", webhookSecret: "lin-webhook-secret" };
const ORG = { type: "org" as const, id: "local-org" };

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

function useFixture(overrides: Parameters<typeof startLinearFixture>[0] = {}): LinearFixture {
  fixture = startLinearFixture(overrides);
  process.env.LINEAR_API_URL = fixture.url;
  return fixture;
}

function saveApp(baseUrl: string, body: Record<string, unknown> = APP, headers = HEADERS): Promise<Response> {
  return fetch(`${baseUrl}/api/org/linear`, { method: "PUT", headers, body: JSON.stringify(body) });
}

function tokenCalls(f: LinearFixture, grant: string): LinearFixtureCall[] {
  return f.calls.filter((call) => call.path === "/oauth/token" && (call.body as Record<string, string>).grant_type === grant);
}

async function status(baseUrl: string): Promise<Record<string, unknown>> {
  return (await fetch(`${baseUrl}/api/org/linear`, { headers: HEADERS })).json() as Promise<Record<string, unknown>>;
}

describe("PUT /api/org/linear", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    useFixture();
    expect((await saveApp(api.baseUrl, APP, MEMBER_HEADERS)).status).toBe(403);
  });

  it("400s unless all three values are present", async () => {
    api = await bootTestApi();
    const f = useFixture();
    for (const missing of ["clientId", "clientSecret", "webhookSecret"]) {
      const res = await saveApp(api.baseUrl, { ...APP, [missing]: " " });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("webhook signing secret");
    }
    expect(f.calls).toHaveLength(0);
  });

  it("verifies with a client_credentials token, then stores the app, token, secret, and installation", async () => {
    api = await bootTestApi();
    const f = useFixture();
    const res = await saveApp(api.baseUrl);
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
    expect(await api.providers.engineCredentials.get(ORG, "linear_app")).toMatchObject({ apiKey: "lin-client-secret", metadata: { clientId: "lin-client-id" } });
    const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: "lin-org-1", workspaceName: "Turnkey", webhookId: null, connectedBy: "local-user" });
  });

  it("stores nothing and names the fix when Linear refuses the client_credentials grant", async () => {
    api = await bootTestApi();
    useFixture({ oauthToken: () => ({ status: 400, body: { error: "unsupported_grant_type", error_description: "Client does not support the client_credentials grant type" } }) });
    const res = await saveApp(api.baseUrl);
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toContain("turn on Client credentials");
    expect(error).toContain("Linear said: Client does not support the client_credentials grant type");
    expect(await api.providers.engineCredentials.get(ORG, "linear")).toBeNull();
    expect(await api.providers.engineCredentials.get(ORG, "linear_app")).toBeNull();
    expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(0);
  });

  it("names the credentials when Linear rejects the client ID or secret", async () => {
    api = await bootTestApi();
    useFixture({ oauthToken: () => ({ status: 401, body: { error: "invalid_client" } }) });
    const res = await saveApp(api.baseUrl);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Copy the client ID and client secret again");
  });

  it("409s when a different Linear workspace is already connected", async () => {
    api = await bootTestApi();
    useFixture();
    await api.providers.db.insert(linearInstallations).values({
      id: "lin_pre-existing", orgId: "local-org", workspaceId: "lin-org-OTHER", workspaceName: "Other Workspace",
      webhookId: null, connectedBy: "local-user", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const res = await saveApp(api.baseUrl);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Other Workspace");
    expect(await api.providers.engineCredentials.get(ORG, "linear")).toBeNull();
  });

});

describe("GET /api/org/linear", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    expect((await fetch(`${api.baseUrl}/api/org/linear`, { headers: MEMBER_HEADERS })).status).toBe(403);
  });

  it("reports setup inputs and never returns secrets", async () => {
    api = await bootTestApi();
    useFixture();
    const before = await status(api.baseUrl);
    expect(before).toMatchObject({ configured: false, connected: false, ready: false, redirectUri: `${api.baseUrl}/api/org/linear/callback` });
    expect(before.webhookUrl).toBeUndefined();
    expect(before.webhookResourceTypes).toEqual(["Issue", "Comment", "Project", "Cycle", "IssueLabel", "Reaction"]);
    await saveApp(api.baseUrl);
    const after = JSON.stringify(await status(api.baseUrl));
    for (const secret of ["lin-client-secret", "lin-webhook-secret", "lin_app_token"]) expect(after).not.toContain(secret);
  });

  it("offers the public HTTPS event URL for the app webhook", async () => {
    process.env.VALET_PUBLIC_URL = "https://valet.example";
    api = await bootTestApi();
    expect(await status(api.baseUrl)).toMatchObject({
      webhookUrl: "https://valet.example/webhooks/events/linear",
      redirectUri: "https://valet.example/api/org/linear/callback",
    });
  });
});

describe("DELETE /api/org/linear", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    expect((await fetch(`${api.baseUrl}/api/org/linear`, { method: "DELETE", headers: MEMBER_HEADERS })).status).toBe(403);
  });

  it("removes the installation, token, and app", async () => {
    api = await bootTestApi();
    useFixture();
    await saveApp(api.baseUrl);
    expect((await fetch(`${api.baseUrl}/api/org/linear`, { method: "DELETE", headers: HEADERS })).status).toBe(204);
    expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(0);
    expect(await api.providers.engineCredentials.get(ORG, "linear")).toBeNull();
    expect(await api.providers.engineCredentials.get(ORG, "linear_app")).toBeNull();
    expect(await status(api.baseUrl)).toMatchObject({ configured: false, connected: false, ready: false });
  });

  it("removes a webhook an older connection created, and still disconnects when that fails", async () => {
    for (const ok of [true, false]) {
      api = await bootTestApi();
      const f = useFixture(ok ? {} : { webhookDelete: () => ({ status: 500, body: { errors: [{ message: "boom" }] } }) });
      await saveApp(api.baseUrl);
      await api.providers.db.update(linearInstallations).set({ webhookId: "wh-legacy" }).where(eq(linearInstallations.orgId, "local-org"));
      expect((await fetch(`${api.baseUrl}/api/org/linear`, { method: "DELETE", headers: HEADERS })).status).toBe(204);
      const [deleteCall] = f.calls.filter((call) => JSON.stringify(call.body ?? "").includes("webhookDelete"));
      expect((deleteCall.body as { variables: { id: string } }).variables.id).toBe("wh-legacy");
      expect(await api.providers.db.select().from(linearInstallations)).toHaveLength(0);
      await api.cleanup(); api = undefined;
      await f.close(); fixture = undefined;
    }
  });
});

it("reserves Linear application credentials from generic mutation routes", async () => {
  api = await bootTestApi();
  for (const method of ["PUT", "DELETE"]) {
    const response = await fetch(`${api.baseUrl}/api/credentials/linear_app?scope=org`, {
      method, headers: HEADERS,
      ...(method === "PUT" ? { body: JSON.stringify({ scope: "org", type: "api_key", apiKey: "secret" }) } : {}),
    });
    expect(response.status).toBe(400);
  }
});
