import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { buildPolicyResolver } from "../policies/service.js";
import { membersSharing } from "./credential-shares.js";
import { readTeamCredential } from "./credential-resolution.js";
import { usableTeamGithubRow } from "./session-github-token.js";

// Exercise the upgrade against encrypted source credentials, not copied token fixtures.
describe("migrated GitHub delegation", () => {
  const pglite = new PGlite();
  const pg = pgDbFromPglite(pglite);
  const db = buildAppDb(pglite);
  const credentials = new PgCredentialStore(pg, deriveSecretKey("migration-test-key"));
  const teamId = "migration-team";
  const orgId = "migration-org";
  const memberId = "migration-sharer";
  const deps = { credentials, shares: (team: string, service: string) => membersSharing(db, team, service) };

  beforeAll(async () => {
    await applyAppMigrations(pg);
    await pg.query("INSERT INTO team_members(team_id, user_id, role) VALUES ($1, $2, 'member')", [teamId, memberId]);
    await credentials.save({ type: "user", id: memberId }, "github", { type: "api_key", apiKey: "github-source-token" });
    await credentials.save({ type: "team", id: teamId }, "github", {
      type: "api_key", metadata: { delegatedFrom: memberId, sourceType: "api_key" },
    });
    await pg.query("DROP TABLE credential_shares");
    await applyAppMigrations(pg);
  });
  afterAll(async () => { await pg.close(); });

  it("moves the reference once and preserves the sharer's live GitHub credential", async () => {
    expect(await credentials.get({ type: "team", id: teamId }, "github")).toBeNull();
    expect(await membersSharing(db, teamId, "github")).toEqual([memberId]);
    expect(await usableTeamGithubRow(deps, { orgId, teamId, userId: memberId }, "reference-only"))
      .toMatchObject({ apiKey: "github-source-token" });
    await applyAppMigrations(pg);
    expect(await membersSharing(db, teamId, "github")).toEqual([memberId]);
    await credentials.save({ type: "user", id: memberId }, "github", { type: "api_key", apiKey: "github-refreshed-token" });
    expect(await usableTeamGithubRow(deps, { orgId, teamId, userId: memberId }, "reference-only"))
      .toMatchObject({ apiKey: "github-refreshed-token" });
  });

  it("withholds another member's share and exposes the current GitHub approval exception", async () => {
    const actor = { orgId, teamId, userId: "another-actor" };
    expect(await readTeamCredential(deps, actor, "github", "reference-only"))
      .toEqual({ credential: null, approvalFrom: memberId });
    expect(await usableTeamGithubRow(deps, actor, "reference-only")).toBeNull();
    // The provider can consume a grant, but the production GitHub policy path
    // does not offer a borrow gate. It falls through to the organization App.
    const resolver = buildPolicyResolver({ db, actionPluginByService: new Map(), credentials });
    const decision = await resolver.resolve({
      ...actor, service: "github", actionId: "github.get_issue", riskLevel: "low", params: {},
      sessionId: "migration-session", threadId: "migration-thread", appliesIn: "session",
    });
    expect(decision.approver).toBeUndefined();
    expect(decision.provenance.source).not.toBe("shared_account");
  });
});
