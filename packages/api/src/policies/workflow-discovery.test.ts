import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { pgDbFromPglite } from "@valet/store-postgres";
import { InMemoryCredentialStore, VirtualSandboxProvider, pluginCatalogTools, type ToolContext, type DecisionGateRequest } from "@valet/engine";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { orgs, users, orgMembers, teams, teamMembers, assistants, agentSessions, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { shareCredential } from "../services/credential-shares.js";
import { buildPolicyResolver } from "./service.js";
import { canBorrowCredential, isUnattendedTeamSession } from "../services/credential-borrow.js";
import { workflowSessionOwner } from "../workflows/session-owner.js";

const pg = new PGlite();
const db = buildAppDb(pg);
const ORG = "test-org", TEAM = "test-team", HUMAN = "test-human", LENDER = "test-lender";
const SERVICE = "test_remote", WORKSPACE = "test-workspace", WORKFLOW = "wf:test-run:document";
const creds = new InMemoryCredentialStore();

beforeAll(async () => {
  await applyAppMigrations(pgDbFromPglite(pg));
  await db.insert(orgs).values({ id: ORG, name: "Test", createdAt: 1 });
  for (const id of [HUMAN, LENDER]) {
    await db.insert(users).values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member", createdAt: 1 });
  }
  await db.insert(teams).values({ id: TEAM, orgId: ORG, name: "Test", createdAt: 1 });
  await db.insert(teamMembers).values([HUMAN, LENDER].map(userId => ({ teamId: TEAM, userId, role: "member" as const })));
  await db.insert(agentSessions).values({ id: WORKSPACE, userId: HUMAN, orgId: ORG, workspace: "/workspace", ownerType: "team", ownerId: TEAM, createdAt: 1, updatedAt: 1 });
  await db.insert(assistants).values({ id: "test-assistant", orgId: ORG, ownerType: "team", ownerId: TEAM, sessionId: WORKSPACE, createdAt: 1 });
  const graph = { version: "dag/v1", nodes: [], edges: [] };
  await db.insert(workflowDefinitions).values({ id: "test-definition", orgId: ORG, ownerType: "team", ownerId: TEAM, name: "Test", definition: graph, createdAt: 1, updatedAt: 1 });
  await db.insert(workflowRuns).values({ id: "test-run", workflowId: "test-definition", definitionVersionId: "v1", definition: graph, params: {}, ownerType: "team", ownerId: TEAM, actorUserId: `team:${TEAM}`, createdAt: 1, updatedAt: 1 });
  await db.insert(workflowRuns).values({ id: "test-human-run", workflowId: "test-definition", definitionVersionId: "v1", definition: graph, params: {}, ownerType: "team", ownerId: TEAM, actorUserId: HUMAN, createdAt: 1, updatedAt: 1 });
  expect(await workflowSessionOwner(db, WORKFLOW, ORG)).toEqual({ type: "team", id: TEAM });
  expect(await workflowSessionOwner(db, "wf:test-human-run:document", ORG)).toEqual({ type: "team", id: TEAM });
  await shareCredential(db, { teamId: TEAM, service: SERVICE, userId: LENDER, createdAt: 1 });
  await creds.save({ type: "user", id: LENDER }, SERVICE, { type: "api_key", apiKey: "fake-test-credential" });
});
afterAll(async () => { await pg.close(); });

it.each([
  { label: "human in workflow", sessionId: "wf:test-human-run:document", actor: HUMAN },
  { label: "unattended workspace", sessionId: WORKSPACE, actor: `team:${TEAM}` },
  { label: "unattended workflow", sessionId: WORKFLOW, actor: `team:${TEAM}` },
])("requests lender approval for $label", async ({ sessionId, actor }) => {
  const resolver = buildPolicyResolver({ db, actionPluginByService: new Map(), credentials: creds });
  const policy = await resolver.resolve({ teamId: TEAM, service: SERVICE, actionId: `${SERVICE}.__valet_discovery__`, riskLevel: "low", params: {}, userId: actor, orgId: ORG, sessionId, threadId: "test-thread", appliesIn: "session" });
  const requestDecision = vi.fn(async (_request: DecisionGateRequest) => ({ actionId: "pending", resolvedAt: 1, resolvedBy: "" }));
  const discover = vi.fn(async () => []);
  const sandbox = await new VirtualSandboxProvider().create({ sessionId, workspace: "/workspace" });
  const ctx: ToolContext = {
    userId: actor, orgId: ORG, owner: { type: "team", id: TEAM }, sessionId, threadId: "test-thread", sandbox,
    credentials: { get: async () => null, request: async () => { throw new Error("No live credentials in tests"); } },
    requestDecision, policyResolver: resolver, signal: new AbortController().signal,
    threadRead: async () => [], listThreads: async () => [], setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
  };
  const [list] = pluginCatalogTools({ plugins: [{ service: SERVICE, actions: [], resolveActions: discover }] });
  const result = await list.execute({ service: SERVICE }, ctx);
  expect(policy).toMatchObject({ mode: "require_approval", approver: { userId: LENDER } });
  expect(result.text).toContain("pending-approval");
  expect(requestDecision).toHaveBeenCalledTimes(1);
  expect(requestDecision.mock.calls[0]?.[0].context?.approver).toMatchObject({ userId: LENDER });
  expect(discover).not.toHaveBeenCalled();
});

const unattendedInput = {
  teamId: TEAM, service: SERVICE, actionId: `${SERVICE}.__valet_discovery__`, riskLevel: "low" as const, params: {},
  userId: `team:${TEAM}`, orgId: ORG, sessionId: WORKFLOW, threadId: "test-thread", appliesIn: "session" as const,
};

afterEach(async () => {
  await db.update(workflowDefinitions).set({ orgId: ORG }).where(eq(workflowDefinitions.id, "test-definition"));
  await db.update(workflowRuns).set({ ownerId: TEAM, actorUserId: `team:${TEAM}` }).where(eq(workflowRuns.id, "test-run"));
  await db.delete(agentSessions).where(eq(agentSessions.id, WORKFLOW));
});

it.each(["other organization", "other team", "human run actor", "missing run", "run-only scope", "malformed node", "app-session collision", "wrong synthetic actor"])("does not request workflow account approval for %s", async failure => {
  const input = { ...unattendedInput };
  if (failure === "other organization") await db.update(workflowDefinitions).set({ orgId: "other-org" }).where(eq(workflowDefinitions.id, "test-definition"));
  if (failure === "other team") await db.update(workflowRuns).set({ ownerId: "other-team" }).where(eq(workflowRuns.id, "test-run"));
  if (failure === "human run actor") await db.update(workflowRuns).set({ actorUserId: HUMAN }).where(eq(workflowRuns.id, "test-run"));
  if (failure === "missing run") input.sessionId = "wf:missing:document";
  if (failure === "run-only scope") input.sessionId = "wf:test-run";
  if (failure === "malformed node") input.sessionId = "wf:test-run:..";
  if (failure === "wrong synthetic actor") input.userId = "team:other-team";
  if (failure === "app-session collision") await db.insert(agentSessions).values({ id: WORKFLOW, userId: HUMAN, orgId: ORG, workspace: "/workspace", ownerType: "team", ownerId: TEAM, createdAt: 1, updatedAt: 1 });
  expect(await isUnattendedTeamSession(db, { ...input, actorId: input.userId })).toBe(false);
  const resolver = buildPolicyResolver({ db, actionPluginByService: new Map(), credentials: creds });
  expect(await resolver.resolve(input)).toMatchObject({ mode: "deny", provenance: { source: "shared_account" } });
});

it("lets only the lender grant workflow access and rechecks durable ownership before borrowing", async () => {
  const resolver = buildPolicyResolver({ db, actionPluginByService: new Map(), credentials: creds });
  const decision = await resolver.resolve(unattendedInput);
  const scope = { ...unattendedInput, actorId: unattendedInput.userId, memberId: LENDER };
  await expect(resolver.onResolution!(unattendedInput, decision, { actionId: "approve", resolvedBy: HUMAN, resolvedAt: 1 })).rejects.toThrow(/Only/);
  expect(await canBorrowCredential(db, scope)).toBe(false);
  await resolver.onResolution!(unattendedInput, decision, { actionId: "approve", resolvedBy: LENDER, resolvedAt: 1 });
  expect(await canBorrowCredential(db, scope)).toBe(true);
  expect(await canBorrowCredential(db, { ...scope, sessionId: "wf:test-run" })).toBe(true);
  expect(await resolver.resolve(unattendedInput)).toMatchObject({ mode: "allow" });
  await db.update(workflowDefinitions).set({ orgId: "other-org" }).where(eq(workflowDefinitions.id, "test-definition"));
  expect(await canBorrowCredential(db, scope)).toBe(false);
  expect(await resolver.resolve(unattendedInput)).toMatchObject({ mode: "deny" });
});
