/**
 * Team-owned sessions resolve credentials from the team principal, not the
 * prompting member. GitHub uses the App installation. Slack uses the org
 * bot token and stays bare. A user-owned session is unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { githubInstallations } from "../schema/index.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import slackPlugin from "@valet/plugin-slack/plugin";
import { linkIdentity } from "../channels/identity-links.js";
import { EngineHost } from "./host.js";

const orgId = "team-cred-org";
const userId = "team-cred-user";
const teamId = "team_1";
const NOW = 1_700_000_000_000;

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const appConfig: GithubAppConfig = {
  appId: "1",
  appSlug: "valet-app",
  oauthClientId: "Iv1.abc",
  htmlUrl: "https://github.com/apps/valet-app",
  oauthClientSecret: "client-secret",
  webhookSecret: "webhook-secret",
  privateKeyPem,
};

describe("EngineHost team-owned session credentials", () => {
  let fixture: GithubFixture | undefined;
  let host: EngineHost | undefined;

  afterEach(async () => {
    host?.evictAll();
    host = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  async function harness(): Promise<{ appDb: AppDb; credentials: PgCredentialStore }> {
    const { appDb, pgdb } = await freshTestPgDb();
    return { appDb, credentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")) };
  }

  function makeHost(appDb: AppDb, credentials: PgCredentialStore, fixtureUrl: string): EngineHost {
    const h = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      db: appDb,
      plugins: [slackPlugin],
      githubTokenDeps: {
        key: deriveSecretKey("cache-key"),
        apiUrl: fixtureUrl,
        githubUrl: fixtureUrl,
        now: () => NOW,
      },
    });
    host = h;
    return h;
  }

  const teamMeta = {
    userId,
    orgId,
    workspace: "/tmp",
    ownerType: "team" as const,
    ownerTeamId: teamId,
  };

  it("resolves GitHub through the installation, not the prompting member", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_team",
      orgId,
      installationId: 333,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-gh", teamMeta);
    const cred = await session.credentialProvider().get("github");

    expect(cred?.accessToken).toBe("inst-333");
  });

  it("resolves Slack to the org bot token with no owner_slack_user_id", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "oauth2",
      accessToken: "xoxb-org-bot",
      metadata: { team_id: "T99" },
    });
    await linkIdentity(appDb, { provider: "slack", externalId: "U42", userId });

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-slack", teamMeta);
    const cred = await session.credentialProvider().get("slack");

    expect(cred?.accessToken).toBe("xoxb-org-bot");
    expect(cred?.metadata?.["owner_slack_user_id"]).toBeUndefined();
  });

  it("a user-owned session still reads the user row", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      apiKey: "user-linear",
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-user-linear", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("linear");

    expect(cred?.accessToken).toBe("user-linear");
  });
});
