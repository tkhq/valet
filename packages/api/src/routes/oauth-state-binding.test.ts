/**
 * Signed-state binding across the API's browser-redirect flows. Each state
 * opens only the flow that signed it, and the GitHub App setup callback opens
 * only for the org admin who started setup. Each case runs against the legacy
 * URL and the canonical plugin URL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import { credentials, orgMembers } from "../schema/index.js";
import { createTeam } from "../services/teams.js";
import type { PostGithubAppManifestResponse, PostGithubConnectResponse } from "../wire/types.js";

const ADMIN = { "Content-Type": "application/json" };
const OTHER_ADMIN = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };
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

/** The App a manifest conversion returns. In the attack, someone else created it. */
const CONVERTED_APP = {
  id: 6666,
  slug: "other-app",
  name: "Other App",
  client_id: "Iv1.other",
  client_secret: "other-oauth-secret",
  webhook_secret: "other-hook-secret",
  pem: TEST_PEM,
  html_url: "https://github.com/apps/other-app",
};

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;
let oauth: FakeOAuthServer | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  await oauth?.close();
  oauth = undefined;
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function useFixture(): GithubFixture {
  fixture = startGithubFixture({
    listInstallations: () => ({ body: [] }),
    convertManifest: () => ({ body: CONVERTED_APP }),
  });
  process.env.GITHUB_API_URL = fixture.url;
  process.env.GITHUB_URL = fixture.url;
  return fixture;
}

/** An integration that connects through the generic credential-connect flow. */
function mcpPlugin(serverUrl: string): ValetPlugin {
  return {
    name: "linear",
    version: "0.1.0",
    credentials: [{ type: "oauth2", scopes: ["read"], configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl } }],
  };
}

async function boot(): Promise<TestApi> {
  oauth = await startFakeOAuthServer();
  api = await bootTestApi({ plugins: [githubPlugin, mcpPlugin(oauth.url)] });
  return api;
}

/** The organization App credential rows, by owner. */
async function appCredentialOwners(app: TestApi): Promise<Array<{ ownerId: string }>> {
  return app.providers.db.select({ ownerId: credentials.ownerId }).from(credentials)
    .where(and(eq(credentials.ownerType, "org"), eq(credentials.service, "github_app")));
}

const SURFACES = [
  {
    name: "legacy",
    manifest: "/api/org/github-app/manifest",
    setup: "/api/org/github-app/setup",
    connect: "/api/me/github/connect",
    callback: "/api/me/github/callback",
  },
  {
    name: "canonical",
    manifest: "/api/plugins/github/http/app/manifest",
    setup: "/api/plugins/github/http/app/setup",
    connect: "/api/plugins/github/http/connection/connect",
    callback: "/api/plugins/github/http/connection/callback",
  },
] as const;

describe.each(SURFACES)("$name signed-state binding", (surface) => {
  async function setupState(app: TestApi, headers: Record<string, string>): Promise<string> {
    const response = await fetch(`${app.baseUrl}${surface.manifest}`, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200);
    return ((await response.json()) as PostGithubAppManifestResponse).state;
  }

  async function githubConnectState(app: TestApi, headers: Record<string, string>): Promise<string> {
    const response = await fetch(`${app.baseUrl}${surface.connect}`, { method: "POST", headers });
    expect(response.status).toBe(200);
    return new URL(((await response.json()) as PostGithubConnectResponse).url).searchParams.get("state") ?? "";
  }

  /** A team admin who is not an org admin can mint this state. It names the organization. */
  async function teamConnectState(app: TestApi): Promise<string> {
    const team = await createTeam(app.providers.db, { orgId: "local-org", name: "State team", creatorUserId: "test-member" });
    const response = await fetch(`${app.baseUrl}/api/credentials/linear/connect?scope=team&teamId=${team.id}`, {
      redirect: "manual", headers: MEMBER,
    });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
  }

  async function finishSetup(app: TestApi, state: string, headers: Record<string, string>) {
    const response = await fetch(`${app.baseUrl}${surface.setup}?code=conversion-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual", headers,
    });
    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, location: response.headers.get("location"), body };
  }

  describe("GitHub App setup callback", () => {
    it("completes for the org admin who started setup", async () => {
      const app = await boot();
      const f = useFixture();
      const result = await finishSetup(app, await setupState(app, ADMIN), ADMIN);
      expect(result.status).toBe(302);
      expect(result.location).toBe("/settings/organization/github?setup=ok");
      expect(f.calls.some((call) => call.path === "/app-manifests/conversion-code/conversions")).toBe(true);
      expect(await appCredentialOwners(app)).toEqual([{ ownerId: "local-org" }]);
    });

    it("refuses a member's GitHub connect state without calling GitHub or storing an App", async () => {
      Object.assign(process.env, ENV_APP);
      const app = await boot();
      const f = useFixture();
      const state = await githubConnectState(app, MEMBER);
      expect(await finishSetup(app, state, MEMBER)).toEqual({
        status: 400, location: null, body: { error: "invalid or expired state" },
      });
      expect(f.calls).toEqual([]);
      expect(await appCredentialOwners(app)).toEqual([]);
    });

    it("refuses a team credential-connect state without calling GitHub or storing an App", async () => {
      const app = await boot();
      const f = useFixture();
      const state = await teamConnectState(app);
      expect(await finishSetup(app, state, MEMBER)).toEqual({
        status: 400, location: null, body: { error: "invalid or expired state" },
      });
      expect(f.calls).toEqual([]);
      expect(await appCredentialOwners(app)).toEqual([]);
    });

    it.each([
      ["another org admin", OTHER_ADMIN],
      ["a member", MEMBER],
    ])("refuses %s who holds an admin's setup state", async (_who, headers) => {
      const app = await boot();
      const f = useFixture();
      const state = await setupState(app, ADMIN);
      expect(await finishSetup(app, state, headers)).toEqual({
        status: 403,
        location: null,
        body: { error: "Only the org admin who started this GitHub App setup can finish it. Ask an org admin to start the setup again." },
      });
      expect(f.calls).toEqual([]);
      expect(await appCredentialOwners(app)).toEqual([]);
    });

    it("refuses an admin who lost the admin role after starting setup", async () => {
      const app = await boot();
      const f = useFixture();
      const state = await setupState(app, OTHER_ADMIN);
      await app.providers.db.update(orgMembers).set({ role: "member" })
        .where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "test-admin")));
      expect((await finishSetup(app, state, OTHER_ADMIN)).status).toBe(403);
      expect(f.calls).toEqual([]);
      expect(await appCredentialOwners(app)).toEqual([]);
    });
  });

  describe("other flows", () => {
    async function finishGithubConnect(app: TestApi, state: string, headers: Record<string, string>) {
      const response = await fetch(`${app.baseUrl}${surface.callback}?code=c&state=${encodeURIComponent(state)}`, {
        redirect: "manual", headers,
      });
      const text = await response.text();
      const body: unknown = text ? JSON.parse(text) : null;
      return { status: response.status, body };
    }

    async function finishCredentialConnect(app: TestApi, state: string, headers: Record<string, string>) {
      const response = await fetch(`${app.baseUrl}/api/credentials/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
        redirect: "manual", headers,
      });
      return response.headers.get("location");
    }

    it("the GitHub connect callback refuses a setup state and a credential-connect state", async () => {
      Object.assign(process.env, ENV_APP);
      const app = await boot();
      const f = useFixture();
      const invalid = { status: 400, body: { error: "invalid or expired state" } };
      expect(await finishGithubConnect(app, await setupState(app, ADMIN), ADMIN)).toEqual(invalid);
      expect(await finishGithubConnect(app, await teamConnectState(app), MEMBER)).toEqual(invalid);
      expect(f.calls).toEqual([]);
      const saved = await app.providers.db.select({ ownerId: credentials.ownerId }).from(credentials)
        .where(eq(credentials.service, "github"));
      expect(saved).toEqual([]);
    });

    it("the credential-connect callback refuses a setup state and a GitHub connect state", async () => {
      Object.assign(process.env, ENV_APP);
      const app = await boot();
      useFixture();
      expect(await finishCredentialConnect(app, await setupState(app, ADMIN), ADMIN)).toBe("/integrations?error=oauth_state");
      expect(await finishCredentialConnect(app, await githubConnectState(app, MEMBER), MEMBER)).toBe("/integrations?error=oauth_state");
      expect(oauth?.tokenRequests).toEqual([]);
    });
  });
});
