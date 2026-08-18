/**
 * Verifies that `buildCredentialResolver` resolves the org-scoped Slack bot
 * credential and enriches it with the session user's Slack identity link
 * (`owner_slack_user_id`), activating the dormant private-channel check in
 * plugin-slack.
 *
 * The bot token is org-shared by design (`PUT /api/credentials/slack?scope=org`
 * stores it under `{ type: "org", id: orgId }`). The engine's session always
 * calls the resolver with a user owner, so a plain exact-owner read would
 * return null in production. These tests prove the org-scoped fallback and the
 * enrichment path both work correctly.
 *
 * Modelled on host.github-credential.test.ts — same harness, same fixture
 * bootstrapping pattern, exercising the real `Session.credentialProvider()` seam.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { linkIdentity } from "../channels/identity-links.js";
import { EngineHost } from "./host.js";

const orgId = "slack-org";
const userId = "slack-user";

describe("EngineHost session slack credential resolution", () => {
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
      githubTokenDeps: {
        key: deriveSecretKey("cache-key"),
        apiUrl: fixtureUrl,
        githubUrl: fixtureUrl,
        now: () => Date.now(),
      },
    });
    host = h;
    return h;
  }

  it("org-scoped slack credential + linked user → resolves and carries owner_slack_user_id", async () => {
    const { appDb, credentials } = await harness();
    // Store credential under org scope — this is the production path.
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "oauth2",
      accessToken: "xoxb-bot-token",
      metadata: { team_id: "T99" },
    });
    await linkIdentity(appDb, { provider: "slack", externalId: "U42", userId });

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-slack-linked", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("slack");

    expect(cred?.accessToken).toBe("xoxb-bot-token");
    expect(cred?.metadata?.["owner_slack_user_id"]).toBe("U42");
    // Original metadata field must survive the merge.
    expect(cred?.metadata?.["team_id"]).toBe("T99");
  });

  it("org-scoped slack credential + unlinked user → resolves without owner_slack_user_id", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "oauth2",
      accessToken: "xoxb-bot-token",
      metadata: { team_id: "T77" },
    });
    // No linkIdentity call — user has no slack identity link.

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-slack-unlinked", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("slack");

    expect(cred?.accessToken).toBe("xoxb-bot-token");
    expect(Object.prototype.hasOwnProperty.call(cred?.metadata ?? {}, "owner_slack_user_id")).toBe(false);
  });

  it("user-scoped slack credential present → wins over an org-scoped one", async () => {
    const { appDb, credentials } = await harness();
    // Both stored: user-scoped must win.
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "oauth2",
      accessToken: "xoxb-org-token",
      metadata: { team_id: "TORG" },
    });
    await credentials.save({ type: "user", id: userId }, "slack", {
      type: "oauth2",
      accessToken: "xoxb-user-token",
      metadata: { team_id: "TUSER" },
    });
    await linkIdentity(appDb, { provider: "slack", externalId: "U42", userId });

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-slack-user-wins", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("slack");

    expect(cred?.accessToken).toBe("xoxb-user-token");
    expect(cred?.metadata?.["owner_slack_user_id"]).toBe("U42");
    expect(cred?.metadata?.["team_id"]).toBe("TUSER");
  });

  it("non-slack service stored org-scoped only → resolves null (no generic fallback leaked)", async () => {
    const { appDb, credentials } = await harness();
    // Store a linear credential under org scope — the resolver must NOT fall
    // back to org for non-slack services.
    await credentials.save({ type: "org", id: orgId }, "linear", {
      type: "api_key",
      apiKey: "lin-org-key",
      metadata: { workspace_id: "WORG" },
    });
    await linkIdentity(appDb, { provider: "slack", externalId: "U42", userId });

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-linear-no-fallback", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("linear");

    expect(cred).toBeNull();
  });
});
