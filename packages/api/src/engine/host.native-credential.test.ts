/**
 * Native integration credential policy, Part B
 * (docs/specs/2026-10-15-native-integration-credential-policy-design.md).
 *
 * Every row of the resolution-order table, per session owner, for Linear,
 * read through a real `EngineHost` session's `credentialProvider()`. The
 * Linear plugin reads `linear` first and `linear:app` when that is null
 * (Task 3), so `partB` composes those two reads the same way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type StoredCredential, type ValetPlugin } from "@valet/engine";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { teamMembers, teams, users } from "../schema/index.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { shareCredential } from "../services/credential-shares.js";
import { configMcpPlugins } from "../plugins/config-mcp.js";
import { CredentialReferenceBrokenError } from "../plugins/team-credential-store.js";
import * as credentialMetrics from "../observability/credential-metrics.js";
import { EngineHost } from "./host.js";

const orgId = "native-org";
const userId = "u-001";
const sharer = "u-002";
const teamId = "platform";
const NOW = 1_700_000_000_000;

const appRow: StoredCredential = {
  type: "oauth2",
  accessToken: "lin-app-token",
  metadata: { webhookSecret: "hook-secret-value", workspaceId: "ws-value", grant: "client_credentials", connectionId: "conn-value" },
};
const LEAKS = ["webhookSecret", "hook-secret-value", "workspaceId", "ws-value", "connectionId", "conn-value", "grant"];

describe("EngineHost native credential policy (Part B)", () => {
  let fixture: GithubFixture | undefined;
  let host: EngineHost | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    host?.evictAll();
    host = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  async function harness(): Promise<{ appDb: AppDb; credentials: PgCredentialStore }> {
    const { appDb, pgdb } = await freshTestPgDb();
    await appDb.insert(teams).values({ id: teamId, orgId, name: "Platform", createdAt: NOW });
    await appDb.insert(teamMembers).values([{ teamId, userId, role: "member" }, { teamId, userId: sharer, role: "member" }]);
    const credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await credentials.save({ type: "org", id: orgId }, "linear", appRow);
    return { appDb, credentials };
  }

  function makeHost(appDb: AppDb, credentials: PgCredentialStore, plugins: ValetPlugin[] = [linearPlugin, slackPlugin]): EngineHost {
    fixture = startGithubFixture();
    const h = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      db: appDb,
      plugins,
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });
    host = h;
    return h;
  }

  const userMeta = { userId, orgId, workspace: "/tmp" };
  const teamMeta = { userId, orgId, workspace: "/tmp", ownerType: "team" as const, ownerTeamId: teamId };
  const orgMeta = { userId, orgId, workspace: "/tmp", ownerType: "org" as const };

  type Provider = ReturnType<Awaited<ReturnType<EngineHost["sessionFor"]>>["credentialProvider"]>;
  async function partB(provider: Provider) {
    return (await provider.get("linear")) ?? (await provider.get("linear:app"));
  }
  /** The reads an action makes as it executes: its own service, then the
   * app step. Only these count a fallback. */
  async function actionRead(provider: Provider) {
    return (await provider.get("linear", { forAction: true })) ?? (await provider.get("linear:app", { forAction: true }));
  }
  function expectAppToken(cred: Awaited<ReturnType<Provider["get"]>>) {
    expect(cred?.accessToken).toBe("lin-app-token");
    expect(cred?.metadata).toBeUndefined();
    const text = JSON.stringify(cred);
    for (const leaked of LEAKS) expect(text).not.toContain(leaked);
  }

  describe("user owner: personal credential → app token", () => {
    it("P1: with no personal connection, the read ends at the app token", async () => {
      const { appDb, credentials } = await harness();
      const session = await makeHost(appDb, credentials).sessionFor("sess-u1", userMeta);
      const provider = session.credentialProvider();

      // `linear` stays personal: the org app row is not a member's credential.
      expect(await provider.get("linear")).toBeNull();
      expectAppToken(await partB(provider));
    });

    it("P2 / INV-P3: a personal connection wins over the app", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "personal-linear" });
      const session = await makeHost(appDb, credentials).sessionFor("sess-u2", userMeta);

      expect((await partB(session.credentialProvider()))?.accessToken).toBe("personal-linear");
    });
  });

  describe("team owner: acting member's share → team connection → approved shares → app token", () => {
    it("the acting member's own share comes first", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "acting-share" });
      await credentials.save({ type: "team", id: teamId }, "linear", { type: "oauth2", accessToken: "team-linear" });
      await shareCredential(appDb, { teamId, service: "linear", userId, createdAt: 1 });
      const session = await makeHost(appDb, credentials).sessionFor("sess-t1", teamMeta);

      expect((await partB(session.credentialProvider({ actorId: userId })))?.accessToken).toBe("acting-share");
    });

    it("the team's own connection comes next", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "team", id: teamId }, "linear", { type: "oauth2", accessToken: "team-linear" });
      const session = await makeHost(appDb, credentials).sessionFor("sess-t2", teamMeta);

      expect((await partB(session.credentialProvider({ actorId: userId })))?.accessToken).toBe("team-linear");
    });

    it("P3 / INV-P3: another member's approved share comes before the app", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: sharer }, "linear", { type: "oauth2", accessToken: "u-002-linear" });
      await shareCredential(appDb, { teamId, service: "linear", userId: sharer, createdAt: 1, borrowConsentAt: 1 });
      const session = await makeHost(appDb, credentials).sessionFor("sess-t3", teamMeta);

      expect((await partB(session.credentialProvider({ actorId: userId })))?.accessToken).toBe("u-002-linear");
    });

    // Review focus 1: a dead tier is skipped, and the app token is the
    // next tier, not an error.
    it("an acting member's dead share falls to the app token, not an error", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "expired", expiresAt: 1 });
      await shareCredential(appDb, { teamId, service: "linear", userId, createdAt: 1 });
      const session = await makeHost(appDb, credentials).sessionFor("sess-t5", teamMeta);
      const provider = session.credentialProvider({ actorId: userId });

      expect(await provider.get("linear")).toBeNull();
      expectAppToken(await partB(provider));
    });

    it("a dead team connection falls to the app token", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "team", id: teamId }, "linear", { type: "oauth2", accessToken: "dead", expiresAt: 1, metadata: { refreshRefused: true } });
      const session = await makeHost(appDb, credentials).sessionFor("sess-t6", teamMeta);

      expectAppToken(await partB(session.credentialProvider({ actorId: userId })));
    });

    it("without the app connection, a dead share still names the fix", async () => {
      const { appDb, credentials } = await harness();
      await credentials.delete({ type: "org", id: orgId }, "linear");
      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "expired", expiresAt: 1 });
      await shareCredential(appDb, { teamId, service: "linear", userId, createdAt: 1 });
      const session = await makeHost(appDb, credentials).sessionFor("sess-t7", teamMeta);

      await expect(session.credentialProvider({ actorId: userId }).get("linear")).rejects.toBeInstanceOf(CredentialReferenceBrokenError);
    });

    // The app tier is for members only: a channel sender with no Valet
    // account never acts as the Linear app.
    it("an external sender never reaches the app token, and no fallback is counted", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      const session = await makeHost(appDb, credentials).sessionFor("sess-t8", teamMeta);
      const provider = session.credentialProvider({ externalSender: true });

      expect(await provider.get("linear")).toBeNull();
      expect(await provider.get("linear:app")).toBeNull();
      expect(record).not.toHaveBeenCalled();

      // The team's own connection still answers, as before the policy.
      await credentials.save({ type: "team", id: teamId }, "linear", { type: "oauth2", accessToken: "team-linear" });
      expect((await partB(provider))?.accessToken).toBe("team-linear");
    });

    // A plugin names the fix from whoever holds the account it was handed.
    it("says whose account each tier is", async () => {
      const { appDb, credentials } = await harness();
      await appDb.insert(users).values({ id: sharer, name: "Dana", email: "dana@example.test" });
      await credentials.save({ type: "user", id: sharer }, "linear", { type: "oauth2", accessToken: "u-002-linear" });
      await shareCredential(appDb, { teamId, service: "linear", userId: sharer, createdAt: 1, borrowConsentAt: 1 });
      const h = makeHost(appDb, credentials);

      const team = (await h.sessionFor("sess-src1", teamMeta)).credentialProvider({ actorId: userId });
      expect(await team.get("linear")).toMatchObject({ accessToken: "u-002-linear", source: { kind: "shared", memberId: sharer, memberName: "Dana" } });
      await credentials.save({ type: "team", id: teamId }, "linear", { type: "oauth2", accessToken: "team-linear" });
      expect(await team.get("linear")).toMatchObject({ accessToken: "team-linear", source: { kind: "team" } });
      expect(await team.get("linear:app")).toMatchObject({ source: { kind: "app" } });

      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "personal-linear" });
      const personal = (await h.sessionFor("sess-src2", userMeta)).credentialProvider();
      expect(await personal.get("linear")).toMatchObject({ accessToken: "personal-linear", source: { kind: "personal" } });
      const org = (await h.sessionFor("sess-src3", orgMeta)).credentialProvider();
      expect(await org.get("linear")).toMatchObject({ source: { kind: "app" } });
    });

    it("P4: with no share, team row, or approved share, the read ends at the app token", async () => {
      const { appDb, credentials } = await harness();
      const session = await makeHost(appDb, credentials).sessionFor("sess-t4", teamMeta);
      const provider = session.credentialProvider({ actorId: userId });

      expect(await provider.get("linear")).toBeNull();
      expectAppToken(await partB(provider));
    });
  });

  describe("org owner: app token", () => {
    it("P5: both reads hand the plugin the bare app token only", async () => {
      const { appDb, credentials } = await harness();
      const session = await makeHost(appDb, credentials).sessionFor("sess-o1", orgMeta);
      const provider = session.credentialProvider();

      expectAppToken(await provider.get("linear"));
      expectAppToken(await provider.get("linear:app"));
    });
  });

  // INV-P2: the class check sits in front of the app step.
  describe("non-native services never reach an app token", () => {
    it("linear:app is null for every owner when no native plugin names it", async () => {
      const { appDb, credentials } = await harness();
      const notNative: ValetPlugin = { ...linearPlugin, native: undefined, appCredentialService: undefined };
      const h = makeHost(appDb, credentials, [notNative, slackPlugin]);

      for (const [id, meta] of [["sess-n1", userMeta], ["sess-n2", teamMeta], ["sess-n3", orgMeta]] as const) {
        const session = await h.sessionFor(id, meta);
        expect(await session.credentialProvider({ actorId: userId }).get("linear:app")).toBeNull();
      }
    });

    it("P6: a config-declared MCP server with an app-shaped org row gets nothing in a team or org session", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "org", id: orgId }, "acme-docs", appRow);
      const configPlugins = configMcpPlugins([{ name: "acme-docs", url: "https://mcp.acme.test/mcp", auth: "oauth" }], {});
      const h = makeHost(appDb, credentials, [linearPlugin, slackPlugin, ...configPlugins]);

      const team = await h.sessionFor("sess-c1", teamMeta);
      expect(await team.credentialProvider({ actorId: userId }).get("acme-docs")).toBeNull();
      const org = await h.sessionFor("sess-c2", orgMeta);
      expect(await org.credentialProvider().get("acme-docs")).toBeNull();
    });
  });

  // Part C Slack: no change. A user session still gets the whole org bot row.
  it("Slack keeps the org bot row, metadata included, for a user session", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "org", id: orgId }, "slack", { type: "bot_token", accessToken: "xoxb-org", metadata: { team_id: "T1" } });
    const session = await makeHost(appDb, credentials).sessionFor("sess-s1", userMeta);

    const cred = await session.credentialProvider().get("slack");
    expect(cred?.accessToken).toBe("xoxb-org");
    expect(cred?.metadata?.["team_id"]).toBe("T1");
  });
  // Controller addition 1: a fallback to the app token stays visible, so a
  // broken delegated credential is reported, not hidden.
  describe("valet_credentials_app_fallback_total", () => {
    it("counts a user read with no personal connection as no_personal", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      const session = await makeHost(appDb, credentials).sessionFor("sess-m1", userMeta);
      expectAppToken(await actionRead(session.credentialProvider()));
      expect(record.mock.calls).toEqual([["linear", "no_personal"]]);
    });

    it("counts a team read with no share or team row as no_delegated", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      const session = await makeHost(appDb, credentials).sessionFor("sess-m2", teamMeta);
      expectAppToken(await actionRead(session.credentialProvider({ actorId: userId })));
      expect(record.mock.calls).toEqual([["linear", "no_delegated"]]);
    });

    it("counts a broken team share as dead_delegated", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "expired", expiresAt: 1 });
      await shareCredential(appDb, { teamId, service: "linear", userId, createdAt: 1 });
      const session = await makeHost(appDb, credentials).sessionFor("sess-m3", teamMeta);
      expectAppToken(await actionRead(session.credentialProvider({ actorId: userId })));
      expect(record.mock.calls).toEqual([["linear", "dead_delegated"]]);
    });

    it("counts a dead team connection as dead_delegated", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "team", id: teamId }, "linear", { type: "oauth2", accessToken: "dead", expiresAt: 1, metadata: { refreshRefused: true } });
      const session = await makeHost(appDb, credentials).sessionFor("sess-m4", teamMeta);
      expectAppToken(await actionRead(session.credentialProvider({ actorId: userId })));
      expect(record.mock.calls).toEqual([["linear", "dead_delegated"]]);
    });

    it("counts an org-owned read as org_owner", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      const session = await makeHost(appDb, credentials).sessionFor("sess-m5", orgMeta);
      expectAppToken(await session.credentialProvider().get("linear", { forAction: true }));
      expect(record.mock.calls).toEqual([["linear", "org_owner"]]);
    });

    it("counts a team read whose share waits for its member's approval as approval_pending", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: sharer }, "linear", { type: "oauth2", accessToken: "u-002-linear" });
      await shareCredential(appDb, { teamId, service: "linear", userId: sharer, createdAt: 1 });
      const session = await makeHost(appDb, credentials).sessionFor("sess-m8", teamMeta);
      expectAppToken(await actionRead(session.credentialProvider({ actorId: userId })));
      expect(record.mock.calls).toEqual([["linear", "approval_pending"]]);
    });

    it("counts once per action: discovery and the list_tools probe read without counting", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      const h = makeHost(appDb, credentials);
      const team = (await h.sessionFor("sess-m9", teamMeta)).credentialProvider({ actorId: userId });
      const org = (await h.sessionFor("sess-m10", orgMeta)).credentialProvider();
      // The probe and discovery.
      expectAppToken(await partB(team));
      expectAppToken(await partB(team));
      expectAppToken(await org.get("linear"));
      expect(record).not.toHaveBeenCalled();
      // The action.
      expectAppToken(await actionRead(team));
      expectAppToken(await org.get("linear", { forAction: true }));
      expect(record.mock.calls).toEqual([["linear", "no_delegated"], ["linear", "org_owner"]]);
    });

    it("counts nothing when a person's credential answers or no app is connected", async () => {
      const record = vi.spyOn(credentialMetrics, "recordAppCredentialFallback");
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "personal-linear" });
      const h = makeHost(appDb, credentials);
      expect((await actionRead((await h.sessionFor("sess-m6", userMeta)).credentialProvider()))?.accessToken).toBe("personal-linear");
      await credentials.delete({ type: "org", id: orgId }, "linear");
      expect(await actionRead((await h.sessionFor("sess-m7", teamMeta)).credentialProvider({ actorId: userId }))).toBeNull();
      expect(record).not.toHaveBeenCalled();
    });
  });
});
