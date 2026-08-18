/**
 * Verifies that `buildCredentialResolver` enriches the org `slack` credential
 * with the session user's Slack identity link (`owner_slack_user_id`), activating
 * the dormant private-channel check in plugin-slack.
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

  it("linked user + stored org slack credential → resolved credential has owner_slack_user_id and all original fields", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "slack", {
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

  it("unlinked user → resolved credential identical to the stored one (no owner_slack_user_id)", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "slack", {
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

  it("service === slack with no stored credential → null (no throw)", async () => {
    const { appDb, credentials } = await harness();
    await linkIdentity(appDb, { provider: "slack", externalId: "U11", userId });
    // No slack credential stored.

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-slack-nocred", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("slack");

    expect(cred).toBeNull();
  });

  it("another service (linear) with a linked slack user → metadata untouched", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      apiKey: "lin-key",
      metadata: { workspace_id: "W1" },
    });
    await linkIdentity(appDb, { provider: "slack", externalId: "U42", userId });

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-linear-slack", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("linear");

    expect(cred?.accessToken).toBe("lin-key");
    expect(Object.prototype.hasOwnProperty.call(cred?.metadata ?? {}, "owner_slack_user_id")).toBe(false);
    expect(cred?.metadata?.["workspace_id"]).toBe("W1");
  });
});
