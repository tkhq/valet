import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, credentials, credentialShares, teamMembers, teams, workflowAccountGrants, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { applyAppMigrations, missingSchemaRepairs } from "../lib/drizzle.js";
import { canBorrowCredential } from "./credential-borrow.js";
import { revokeShare, shareCredential } from "./credential-shares.js";
import { revokeWorkflowAccountConsent, saveWorkflowAccountConsent } from "./workflow-account-consent.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const definition = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "step", type: "tool", service: "demo", action: "ping", params: {} }], edges: [{ from: "trigger", to: "step" }] };

async function fixture() {
  api = await bootTestApi();
  const { db, workflowStore } = api.providers;
  await db.insert(teams).values([{ id: "account-team", orgId: "local-org", name: "Account", createdAt: 1 }, { id: "other-team", orgId: "local-org", name: "Other", createdAt: 1 }]);
  await db.insert(teamMembers).values([
    { teamId: "account-team", userId: "local-user", role: "member" },
    { teamId: "account-team", userId: "test-member", role: "member" },
    { teamId: "other-team", userId: "local-user", role: "member" },
  ]);
  for (const userId of ["local-user", "test-member"]) {
    await shareCredential(db, { teamId: "account-team", service: "demo", userId, createdAt: 1 });
    await db.insert(credentials).values({ ownerType: "user", ownerId: userId, service: "demo", type: "api_key", apiKeyEnc: "test", createdAt: 1, updatedAt: 1 });
  }
  await shareCredential(db, { teamId: "account-team", service: "slack", userId: "local-user", createdAt: 1 });
  await db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "slack", type: "api_key", apiKeyEnc: "test", createdAt: 1, updatedAt: 1 });
  await db.insert(workflowDefinitions).values({ id: "account-workflow", orgId: "local-org", ownerType: "team", ownerId: "account-team", name: "Account", definition, createdAt: 1, updatedAt: 1 });
  for (const id of ["account-run-one", "account-run-two", "account-human-run"]) {
    await workflowStore.createRun(id, { workflowId: "account-workflow", definitionVersionId: "v1" }, definition, "v1",
      { ownerType: "team", ownerId: "account-team", actorUserId: id === "account-human-run" ? "test-member" : "team:account-team" });
  }
  const consent = { orgId: "local-org", workflowId: "account-workflow", teamId: "account-team", userId: "local-user", services: ["demo"] };
  const scope = { orgId: "local-org", teamId: "account-team", service: "demo", memberId: "local-user", actorId: "team:account-team", sessionId: "wf:account-run-one:step" };
  return { db, workflowStore, consent, scope };
}

it("reuses the saving person's account consent for later scheduled and human workflow runs", async () => {
  const { db, consent, scope } = await fixture();
  expect(await canBorrowCredential(db, scope)).toBe(false);
  await saveWorkflowAccountConsent(db, consent);
  await saveWorkflowAccountConsent(db, consent);
  for (const sessionId of ["wf:account-run-one:step", "wf:account-run-one", "wf:account-run-two:step:1"]) {
    expect(await canBorrowCredential(db, { ...scope, sessionId })).toBe(true);
  }
  expect(await canBorrowCredential(db, { ...scope, actorId: "test-member", sessionId: "wf:account-human-run:step" })).toBe(true);
  expect(await db.select().from(workflowAccountGrants)).toHaveLength(1);
  expect((await db.select().from(credentialShares)).every(share => share.borrowConsentAt === null)).toBe(true);
});

it("does not authorize other accounts, services, organizations, teams, workflows or chats", async () => {
  const { db, workflowStore, consent, scope } = await fixture();
  await saveWorkflowAccountConsent(db, consent);
  await db.insert(workflowDefinitions).values({ id: "different-workflow", orgId: "local-org", ownerType: "team", ownerId: "account-team", name: "Other", definition, createdAt: 1, updatedAt: 1 });
  await workflowStore.createRun("other-run", { workflowId: "different-workflow", definitionVersionId: "v1" }, definition, "v1", { ownerType: "team", ownerId: "account-team", actorUserId: scope.actorId });
  for (const change of [
    { memberId: "test-member" }, { service: "slack" }, { orgId: "different-org" },
    { teamId: "other-team", actorId: "team:other-team" }, { sessionId: "wf:other-run:step" },
    { sessionId: "ordinary-chat", threadId: "thread" }, { sessionId: "wf:missing:step" }, { actorId: "outsider" },
    { actorId: "test-member" },
  ]) expect(await canBorrowCredential(db, { ...scope, ...change })).toBe(false);
});

it("cannot save account consent against another team's workflow or organization", async () => {
  const { db, consent } = await fixture();
  for (const change of [{ orgId: "different-org" }, { teamId: "other-team" }, { workflowId: "missing" }, { userId: "outsider" }, { services: [] }]) {
    await saveWorkflowAccountConsent(db, { ...consent, ...change });
  }
  expect(await db.select().from(workflowAccountGrants)).toHaveLength(0);
});

it("requires a new workflow save after a share is revoked and shared again", async () => {
  const { db, consent, scope } = await fixture();
  await saveWorkflowAccountConsent(db, consent);
  expect(await canBorrowCredential(db, scope)).toBe(true);
  const share = { teamId: scope.teamId, service: scope.service, userId: scope.memberId };
  await revokeShare(db, share);
  expect(await canBorrowCredential(db, scope)).toBe(false);
  await shareCredential(db, { ...share, createdAt: 2 });
  expect(await canBorrowCredential(db, scope)).toBe(false);
  await saveWorkflowAccountConsent(db, consent);
  expect(await canBorrowCredential(db, scope)).toBe(true);
});

it.each(["lender", "actor", "credential"])("rejects workflow account consent after removing the %s", async removed => {
  const { db, consent, scope } = await fixture();
  await saveWorkflowAccountConsent(db, consent);
  const human = { ...scope, actorId: "test-member", sessionId: "wf:account-human-run:step" };
  expect(await canBorrowCredential(db, human)).toBe(true);
  if (removed === "credential") await db.delete(credentials).where(and(eq(credentials.ownerType, "user"), eq(credentials.ownerId, scope.memberId), eq(credentials.service, scope.service)));
  else await db.delete(teamMembers).where(and(eq(teamMembers.teamId, scope.teamId), eq(teamMembers.userId, removed === "lender" ? scope.memberId : "test-member")));
  expect(await canBorrowCredential(db, human)).toBe(false);
  if (removed !== "actor") expect(await canBorrowCredential(db, scope)).toBe(false);
});

it("allows layout edits but rejects old run snapshots after a new save authorizes changed steps", async () => {
  const { db, workflowStore, consent, scope } = await fixture();
  await saveWorkflowAccountConsent(db, consent);
  await db.update(workflowDefinitions).set({ definition: { ...definition, ui: { viewport: { x: 1 } } } }).where(eq(workflowDefinitions.id, consent.workflowId));
  expect(await canBorrowCredential(db, scope)).toBe(true);
  const changed = { ...definition, nodes: [...definition.nodes, { id: "extra", type: "tool", service: "demo", action: "other", params: {} }] };
  await db.update(workflowDefinitions).set({ definition: changed }).where(eq(workflowDefinitions.id, consent.workflowId));
  await revokeWorkflowAccountConsent(db, consent.orgId, consent.workflowId);
  await saveWorkflowAccountConsent(db, consent);
  expect(await canBorrowCredential(db, scope)).toBe(false);
  await workflowStore.createRun("new-definition-run", { workflowId: consent.workflowId, definitionVersionId: "v2" }, changed, "v2",
    { ownerType: "team", ownerId: scope.teamId, actorUserId: scope.actorId });
  expect(await canBorrowCredential(db, { ...scope, sessionId: "wf:new-definition-run:step" })).toBe(true);
});

it("rejects workflow account consent after scoped grant revocation", async () => {
  const { db, consent, scope } = await fixture();
  await saveWorkflowAccountConsent(db, consent);
  await revokeWorkflowAccountConsent(db, "different-org", consent.workflowId);
  expect(await canBorrowCredential(db, scope)).toBe(true);
  await revokeWorkflowAccountConsent(db, consent.orgId, consent.workflowId);
  expect(await canBorrowCredential(db, scope)).toBe(false);
});

it.each(["definition-owner", "run-owner", "session-collision"])("rejects a workflow account grant with changed %s", async changed => {
  const { db, consent, scope } = await fixture();
  await saveWorkflowAccountConsent(db, consent);
  if (changed === "definition-owner") await db.update(workflowDefinitions).set({ ownerId: "other-team" }).where(eq(workflowDefinitions.id, consent.workflowId));
  if (changed === "run-owner") await db.update(workflowRuns).set({ ownerId: "other-team" }).where(eq(workflowRuns.id, "account-run-one"));
  if (changed === "session-collision") await db.insert(agentSessions).values({ id: scope.sessionId, orgId: scope.orgId, ownerType: "team", ownerId: "other-team", userId: "test-member", workspace: "test", createdAt: 1, updatedAt: 1 });
  expect(await canBorrowCredential(db, scope)).toBe(false);
});

it.each(["membership", "credential", "share"])("does not save workflow consent without the current %s", async missing => {
  const { db, consent } = await fixture();
  if (missing === "membership") await db.delete(teamMembers).where(and(eq(teamMembers.teamId, consent.teamId), eq(teamMembers.userId, consent.userId)));
  if (missing === "credential") await db.delete(credentials).where(and(eq(credentials.ownerType, "user"), eq(credentials.ownerId, consent.userId), eq(credentials.service, "demo")));
  if (missing === "share") await revokeShare(db, { teamId: consent.teamId, userId: consent.userId, service: "demo" });
  await saveWorkflowAccountConsent(db, consent);
  expect(await db.select().from(workflowAccountGrants)).toHaveLength(0);
});

it("supports a webhook run with no human actor and refuses a malformed workflow session", async () => {
  const { db, consent, scope } = await fixture();
  await db.update(workflowRuns).set({ actorUserId: null }).where(eq(workflowRuns.id, "account-run-one"));
  await saveWorkflowAccountConsent(db, consent);
  expect(await canBorrowCredential(db, scope)).toBe(true);
  expect(await canBorrowCredential(db, { ...scope, sessionId: "wf:account-run-one:step:0" })).toBe(false);
});

it("repairs already migrated account-consent storage without deleting saved data", async () => {
  const database = pgDbFromPglite(new PGlite());
  try {
    await applyAppMigrations(database);
    await database.query("DROP TABLE workflow_account_grants");
    expect((await missingSchemaRepairs(database)).map(repair => repair.describe)).toContain("workflow account grants");
    await applyAppMigrations(database);
    await database.query(`INSERT INTO workflow_account_grants (org_id, workflow_id, team_id, service, member_id, share_generation, created_at)
      VALUES ('repair-org', 'repair-workflow', 'repair-team', 'demo', 'repair-member', 'repair-generation', 1)`);
    await database.query("DROP INDEX workflow_account_grants_share");
    await applyAppMigrations(database);
    await applyAppMigrations(database);
    expect((await database.query("SELECT member_id, share_generation FROM workflow_account_grants")).rows).toEqual([
      { member_id: "repair-member", share_generation: "repair-generation" },
    ]);
    expect((await missingSchemaRepairs(database)).map(repair => repair.describe)).not.toContain("workflow account share lookup");
  } finally {
    await database.close();
  }
});
