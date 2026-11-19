/**
 * `ownAccount` credential reads: an action that acts as the person (commit
 * signing) gets the turn author's own connection, shared with the team or
 * not, and never the team's row, another member's share, or the app token.
 */
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type StoredCredential } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { teamMembers, teams } from "../schema/index.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { shareCredential } from "../services/credential-shares.js";
import { EngineHost } from "./host.js";

const orgId = "own-org";
const userId = "u-101";
const teammate = "u-102";
const teamId = "platform";
const NOW = 1_700_000_000_000;

const github = (token: string, login: string): StoredCredential => ({
  type: "oauth2",
  accessToken: token,
  expiresAt: NOW + 3_600_000,
  metadata: { login },
});

describe("EngineHost ownAccount reads", () => {
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
    await appDb.insert(teams).values({ id: teamId, orgId, name: "Platform", createdAt: NOW });
    await appDb.insert(teamMembers).values([{ teamId, userId, role: "member" }, { teamId, userId: teammate, role: "member" }]);
    const credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await credentials.save({ type: "team", id: teamId }, "github", github("team-token", "team-bot"));
    return { appDb, credentials };
  }

  function makeHost(appDb: AppDb, credentials: PgCredentialStore): EngineHost {
    fixture = startGithubFixture();
    host = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      db: appDb,
      plugins: [],
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });
    return host;
  }

  const teamMeta = { userId, orgId, workspace: "/tmp", ownerType: "team" as const, ownerTeamId: teamId };

  it("reads the author's own GitHub in a team session, though it is not shared with the team", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", github("own-token", "octo"));
    const session = await makeHost(appDb, credentials).sessionFor("sess-own-1", teamMeta);
    const provider = session.credentialProvider({ actorId: userId });

    expect(await provider.get("github", { ownAccount: true })).toMatchObject({ accessToken: "own-token", source: { kind: "personal" } });
  });

  it("answers nothing, not the team's or a teammate's account, when the author has no GitHub", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: teammate }, "github", github("teammate-token", "other"));
    await shareCredential(appDb, { teamId, service: "github", userId: teammate, createdAt: 1 });
    const session = await makeHost(appDb, credentials).sessionFor("sess-own-2", teamMeta);

    expect(await session.credentialProvider({ actorId: userId }).get("github", { ownAccount: true })).toBeNull();
  });

  it("answers nothing for a channel sender with no Valet account", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", github("own-token", "octo"));
    const session = await makeHost(appDb, credentials).sessionFor("sess-own-3", teamMeta);

    expect(await session.credentialProvider({ actorId: userId, externalSender: true }).get("github", { ownAccount: true })).toBeNull();
  });

  it("reads the owner's GitHub in a personal session", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", github("own-token", "octo"));
    const session = await makeHost(appDb, credentials).sessionFor("sess-own-4", { userId, orgId, workspace: "/tmp" });

    expect((await session.credentialProvider().get("github", { ownAccount: true }))?.accessToken).toBe("own-token");
  });
});
