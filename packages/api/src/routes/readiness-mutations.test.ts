/** Readiness mutations persist a full pass at an unchanged repository head. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { contentSources, credentials, githubInstallations, teams, teamMembers, teamJoinEligibilities } from "../schema/index.js";
import { addMember, createTeam, removeMember } from "../services/teams.js";
import { refreshTeamJoinEligibility } from "../services/team-join-eligibility.js";
import { discoveryScanMark } from "../services/content-sync/collector.js";
import { ContentSyncService } from "../services/content-sync/service.js";
import { GitHubSkillRepoReader } from "../services/skill-repo-reader.js";
import { saveAppConfig, discoverInstallations } from "../services/github-app.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { submitDeletionRequest } from "../services/team-deletion-requests.js";
import { invalidateWorkflowSources } from "../services/content-sync/invalidation.js";

const HEADERS = { "Content-Type": "application/json" };
const ORG = "local-org";
const future = () => Date.now() + 3_600_000;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const appConfig = {
  appId: "123", appSlug: "test", oauthClientId: "test-client", htmlUrl: "https://github.com/apps/test",
  privateKeyPem: privateKey, oauthClientSecret: "oauth-secret", webhookSecret: "hook-secret",
};

let api: TestApi;
let fixture: GithubFixture | undefined;

beforeEach(async () => {
  api = await bootTestApi();
  await api.providers.contentSync.stop();
});
afterEach(async () => {
  await api?.cleanup();
  await fixture?.close();
  fixture = undefined;
  vi.unstubAllEnvs();
});

async function source(id: string, overrides: Partial<typeof contentSources.$inferInsert> = {}) {
  await api.providers.db.insert(contentSources).values({
    id, orgId: ORG, ownerType: "team", ownerId: "team-a", repoFullName: `test/${id}`,
    kinds: ["workflows"], status: "ok", nextAttemptAt: future(),
    lastSha: "same-commit", discoveryScan: "scan", lastManifestHash: "manifest",
    createdAt: Date.now(), updatedAt: Date.now(), ...overrides,
  });
}
async function row(id: string) {
  const [result] = await api.providers.db.select().from(contentSources).where(eq(contentSources.id, id));
  return result;
}
async function expectDirty(id: string) {
  expect(await row(id)).toMatchObject({ discoveryScan: null, lastManifestHash: null });
  expect((await row(id)).nextAttemptAt).toBeLessThanOrEqual(Date.now());
}
async function prime(id: string) {
  await api.providers.db.update(contentSources).set({ discoveryScan: "scan", lastManifestHash: "manifest", nextAttemptAt: future() })
    .where(eq(contentSources.id, id));
}

describe("readiness refresh paths", () => {

  it.each(["direct", "approved"])("keeps %s team credential deletion atomic with readiness invalidation", async (mode) => {
    const team = await createTeam(api.providers.db, { orgId: ORG, name: "Delete atomically", creatorUserId: "local-user" });
    const owner = { type: "team", id: team.id } as const;
    await api.providers.engineCredentials.save(owner, "linear", { type: "api_key", apiKey: "original" });
    await source("delete-atomic", { ownerId: team.id });
    let path = `/api/credentials/linear?scope=team&teamId=${team.id}`;
    if (mode === "approved") {
      const { request } = await submitDeletionRequest(api.providers.db, { orgId: ORG, userId: "local-user", teamId: team.id }, "credential", "linear");
      path = `/api/teams/${team.id}/deletion-requests/${request.id}/approve`;
    }
    const remove = () => fetch(`${api.baseUrl}${path}`, {
      method: mode === "direct" ? "DELETE" : "POST", headers: HEADERS,
      ...(mode === "approved" ? { body: "{}" } : {}),
    });
    await api.providers.db.execute(sql`ALTER TABLE skill_sources ADD CONSTRAINT reject_delete_refresh CHECK (sync_revision = 0)`);
    try {
      expect((await remove()).status).toBe(500);
      expect(await api.providers.engineCredentials.get(owner, "linear")).toMatchObject({ apiKey: "original" });
      expect((await row("delete-atomic")).syncRevision).toBe(0);
    } finally {
      await api.providers.db.execute(sql`ALTER TABLE skill_sources DROP CONSTRAINT reject_delete_refresh`);
    }
    expect((await remove()).status).toBe(200);
    expect(await api.providers.engineCredentials.get(owner, "linear")).toBeNull();
    await expectDirty("delete-atomic");
  });

  it("refreshes every team in the org on credential PUT/DELETE, excluding other scopes and disabled sources", async () => {
    await source("a");
    await source("b", { ownerId: "team-b" });
    await source("foreign", { orgId: "other-org" });
    await source("skills", { kinds: ["skills"] });
    await source("disabled", { enabled: false });
    await source("personal", { ownerType: "user", ownerId: "local-user" });
    await source("org", { ownerType: "org", ownerId: ORG });
    const excluded = ["foreign", "skills", "disabled", "personal", "org"];
    for (const method of ["PUT", "DELETE"]) {
      const response = await fetch(`${api.baseUrl}/api/credentials/linear?scope=org`, {
        method, headers: HEADERS,
        ...(method === "PUT" ? { body: JSON.stringify({ scope: "org", type: "api_key", apiKey: "org-secret" }) } : {}),
      });
      expect(response.status).toBe(200);
      await expectDirty("a");
      await expectDirty("b");
      for (const id of excluded) expect((await row(id)).syncRevision).toBe(0);
      await prime("a");
      await prime("b");
    }
  });

  it("refreshes org reference writes through token-scoped resolution", async () => {
    api.providers.onePassword = {
      tokenConnected: async () => true,
      listVaults: async () => [],
      resolveReference: async () => "resolved-token",
      resolveCredential: async (row) => row,
      findCredentialForService: async () => null,
      findCandidates: async () => [],
    };
    const team = await createTeam(api.providers.db, { orgId: ORG, name: "Team", creatorUserId: "local-user" });
    await source("reference", { ownerId: team.id });
    const response = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT", headers: HEADERS, body: JSON.stringify({ scope: "org", type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" } }),
    });
    expect(response.status).toBe(200);
    await expectDirty("reference");

  });

  it.each(["setup", "credential"])("refreshes saved App configuration via %s even when discovery fails", async (path) => {
    await source("github");
    fixture = startGithubFixture({
      listInstallations: () => ({ status: 500, body: { message: "unavailable" } }),
      convertManifest: () => ({ body: { id: 123, slug: "test", name: "Test", client_id: "client",
        client_secret: "secret", webhook_secret: "hook", pem: privateKey, html_url: "https://github.com/apps/test" } }),
    });
    vi.stubEnv("GITHUB_API_URL", fixture.url);
    if (path === "setup") {
      const start = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
        method: "POST", headers: HEADERS, body: JSON.stringify({}),
      });
      const body: unknown = await start.json();
      if (!body || typeof body !== "object" || !("state" in body) || typeof body.state !== "string") throw new Error("Missing manifest state");
      const response = await fetch(`${api.baseUrl}/api/org/github-app/setup?code=code&state=${encodeURIComponent(body.state)}`, { redirect: "manual" });
      expect(response.status).toBe(302);
    } else {
      const response = await fetch(`${api.baseUrl}/api/org/github-app/credential`, {
        method: "POST", headers: HEADERS, body: JSON.stringify({ appId: "1", privateKey }),
      });
      expect(response.status).toBe(200);
    }
    await expectDirty("github");
    expect(await api.providers.engineCredentials.get({ type: "org", id: ORG }, "github_app")).not.toBeNull();
  });

  it("rolls back a credential write or deletion if durable invalidation fails", async () => {
    const owner = { type: "org", id: ORG } as const;
    await api.providers.engineCredentials.save(owner, "linear", { type: "api_key", apiKey: "original" });
    await source("atomic");
    await api.providers.db.execute(sql`ALTER TABLE skill_sources ADD CONSTRAINT reject_refresh CHECK (sync_revision = 0)`);
    try {
      await expect(api.providers.engineCredentials.save(owner, "linear", { type: "api_key", apiKey: "replacement" })).rejects.toThrow();
      expect(await api.providers.engineCredentials.get(owner, "linear")).toMatchObject({ apiKey: "original" });
      await expect(api.providers.engineCredentials.delete(owner, "linear")).rejects.toThrow();
      expect(await api.providers.engineCredentials.get(owner, "linear")).toMatchObject({ apiKey: "original" });
    } finally {
      await api.providers.db.execute(sql`ALTER TABLE skill_sources DROP CONSTRAINT reject_refresh`);
    }
  });

  it("rolls back the authorized team insert if its refresh cannot persist", async () => {
    const team = await createTeam(api.providers.db, { orgId: ORG, name: "Atomic team", creatorUserId: "local-user" });
    await source("atomic-team", { ownerId: team.id });
    await api.providers.db.execute(sql`ALTER TABLE skill_sources ADD CONSTRAINT reject_refresh CHECK (sync_revision = 0)`);
    try {
      const response = await fetch(`${api.baseUrl}/api/credentials/linear`, {
        method: "PUT", headers: HEADERS, body: JSON.stringify({ scope: "team", teamId: team.id, type: "api_key", apiKey: "secret", createOnly: true }),
      });
      expect(response.status).toBe(500);
      expect(await api.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toBeNull();
    } finally {
      await api.providers.db.execute(sql`ALTER TABLE skill_sources DROP CONSTRAINT reject_refresh`);
    }
  });

  it("keeps error backoff while durably invalidating both comparison markers", async () => {
    const due = future();
    await source("error", { status: "error", nextAttemptAt: due });
    await invalidateWorkflowSources(api.providers.db, { orgId: ORG });
    expect(await row("error")).toMatchObject({ nextAttemptAt: due, syncRevision: 1, discoveryScan: null, lastManifestHash: null });
  });

  it("refreshes a delegated team on membership removal and re-addition", async () => {
    const team = await createTeam(api.providers.db, { orgId: ORG, name: "Team", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    await source("membership", { ownerId: team.id });
    await source("unrelated");
    await removeMember(api.providers.db, { teamId: team.id, userId: "test-member" });
    await expectDirty("membership");
    await prime("membership");
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    await expectDirty("membership");
    expect((await row("unrelated")).syncRevision).toBe(0);
  });

  async function eligibleJoin() {
    await api.providers.db.insert(teams).values({ id: "join-team", orgId: ORG, name: "Join team",
      origin: "idp", externalId: "/platform", createdAt: Date.now() });
    await refreshTeamJoinEligibility(api.providers.db, {
      orgId: ORG, userId: "local-user", claim: { present: true, paths: ["/platform"] }, adminGroupName: "admins",
    });
    return () => fetch(`${api.baseUrl}/api/teams/join-team/join`, { method: "POST", headers: HEADERS });
  }

  it("refreshes an explicit join once, but not duplicate joins or eligibility changes", async () => {
    const join = await eligibleJoin();
    await source("joined", { ownerId: "join-team" });
    await source("unrelated");
    await refreshTeamJoinEligibility(api.providers.db, {
      orgId: ORG, userId: "local-user", claim: { present: true, paths: ["/platform"] }, adminGroupName: "admins",
    });
    expect((await row("joined")).syncRevision).toBe(0);
    expect((await join()).status).toBe(200);
    await expectDirty("joined");
    expect((await row("joined")).syncRevision).toBe(1);
    await prime("joined");
    expect((await join()).status).toBe(200);
    expect(await row("joined")).toMatchObject({ syncRevision: 1, discoveryScan: "scan", lastManifestHash: "manifest" });
    expect((await row("unrelated")).syncRevision).toBe(0);
  });

  it("does not refresh a denied join and rolls back membership if invalidation fails", async () => {
    const join = await eligibleJoin();
    await source("joined", { ownerId: "join-team" });
    await api.providers.db.execute(sql`ALTER TABLE skill_sources ADD CONSTRAINT reject_join_refresh CHECK (sync_revision = 0)`);
    try {
      expect((await join()).status).toBe(500);
      expect(await api.providers.db.select().from(teamMembers).where(eq(teamMembers.teamId, "join-team"))).toEqual([]);
      expect(await row("joined")).toMatchObject({ syncRevision: 0, discoveryScan: "scan", lastManifestHash: "manifest" });
    } finally {
      await api.providers.db.execute(sql`ALTER TABLE skill_sources DROP CONSTRAINT reject_join_refresh`);
    }
    await api.providers.db.delete(teamJoinEligibilities).where(eq(teamJoinEligibilities.teamId, "join-team"));
    expect((await join()).status).toBe(404);
    expect((await row("joined")).syncRevision).toBe(0);
  });

  it.each([false, true])("keeps the join refresh when an older sync settles (failure: %s)", async (failure) => {
    const join = await eligibleJoin();
    await source("joined", { ownerId: "join-team" });
    await api.providers.db.update(contentSources).set({ discoveryScan: discoveryScanMark("same-commit", ["workflows"]) })
      .where(eq(contentSources.id, "joined"));
    const reader = new GitHubSkillRepoReader();
    function barrier() {
      let resolve = () => {};
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    }
    const reached = barrier();
    const resume = barrier();
    reader.head = async () => {
      reached.resolve();
      await resume.promise;
      if (failure) throw new Error("old transport failure");
      return { sha: "same-commit", treeSha: "same-tree" };
    };
    const sync = new ContentSyncService({ db: api.providers.db, reader, collectors: [] });
    const pending = sync.syncOnce("joined");
    await reached.promise;
    try {
      expect((await join()).status).toBe(200);
    } finally {
      resume.resolve();
    }
    const outcome = await pending;
    if (failure) expect(outcome?.status).toBe("error");
    else expect(outcome?.notice).toContain("superseded");
    await expectDirty("joined");
    expect(await row("joined")).toMatchObject({ syncRevision: 2, status: "ok" });
  });

  it("refreshes delegated teams on a personal credential replacement and GitHub disconnect", async () => {
    await source("delegated");
    await source("unrelated", { ownerId: "team-b" });
    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", { type: "oauth2", accessToken: "old" });
    await api.providers.engineCredentials.save({ type: "team", id: "team-a" }, "github", {
      type: "oauth2", metadata: { delegatedFrom: "local-user" },
    });
    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT", headers: HEADERS, body: JSON.stringify({ type: "oauth2", accessToken: "new" }),
    });
    expect(put.status).toBe(200);
    await expectDirty("delegated");
    await prime("delegated");
    const disconnect = await fetch(`${api.baseUrl}/api/me/github`, { method: "DELETE" });
    expect(disconnect.status).toBe(204);
    await expectDirty("delegated");
    expect((await row("unrelated")).syncRevision).toBe(0);
    expect(await api.providers.db.select().from(credentials).where(eq(credentials.ownerId, "team-a"))).toHaveLength(0);
  });

  it("refreshes all org teams for installation changes, but not a timestamp-only discovery", async () => {
    await source("github");
    await source("foreign", { orgId: "other-org" });
    await saveAppConfig({ credentials: api.providers.engineCredentials }, ORG, appConfig);
    let installations: { id: number; account: { login: string; type: string }; repository_selection: string; suspended_at: string | null }[] = [{ id: 123, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }];
    fixture = startGithubFixture({ listInstallations: () => ({ body: installations }) });
    const discover = () => discoverInstallations({ db: api.providers.db, credentials: api.providers.engineCredentials,
      key: deriveSecretKey("test"), apiUrl: fixture?.url }, ORG);
    await discover();
    await expectDirty("github");
    await prime("github");
    const before = (await row("github")).syncRevision;
    await discover();
    expect((await row("github")).syncRevision).toBe(before);
    installations = [...installations, { ...installations[0], id: 456, account: { login: "other", type: "Organization" } }];
    await discover();
    await expectDirty("github");
    await prime("github");
    installations = installations.map((installation) => ({ ...installation, suspended_at: "2026-09-10T00:00:00Z" }));
    await discover();
    await expectDirty("github");
    await prime("github");
    installations = [];
    await discover();
    await expectDirty("github");
    expect((await row("foreign")).syncRevision).toBe(0);
  });

  it.each(["suspend", "unsuspend", "deleted"])("refreshes org teams on installation.%s", async (action) => {
    await source("github");
    await source("foreign", { orgId: "other-org" });
    await saveAppConfig({ credentials: api.providers.engineCredentials }, ORG, appConfig);
    await api.providers.db.insert(githubInstallations).values({
      id: "installation", orgId: ORG, installationId: 123, accountLogin: "acme", accountType: "Organization",
      repositorySelection: "all", suspended: action === "unsuspend", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const body = JSON.stringify({ action, installation: { id: 123 } });
    const response = await fetch(`${api.baseUrl}/webhooks/github-app`, {
      method: "POST", body, headers: { ...HEADERS, "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${createHmac("sha256", appConfig.webhookSecret).update(body).digest("hex")}` },
    });
    expect(response.status).toBe(204);
    await expectDirty("github");
    expect((await row("foreign")).syncRevision).toBe(0);
  });

  it("refreshes org teams when the GitHub App is disconnected", async () => {
    await source("github");
    await saveAppConfig({ credentials: api.providers.engineCredentials }, ORG, appConfig);
    const response = await fetch(`${api.baseUrl}/api/org/github-app`, { method: "DELETE" });
    expect(response.status).toBe(204);
    await expectDirty("github");
  });
});
