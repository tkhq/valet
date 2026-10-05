import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { teamMembers, teams, workflowDefinitions } from "../schema/index.js";
import { getWorkflowRunDetail, resolveWorkflowApproval } from "../workflows/service.js";
import { canBorrowCredential, hasBorrowGrant, writeBorrowGrant } from "./credential-borrow.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("lets only the member whose account a workflow step would use answer it, for this run", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await p.db.insert(teams).values({ id: "mine", orgId: "local-org", name: "Mine", createdAt: 1 });
  await p.db.insert(teamMembers).values([
    { teamId: "mine", userId: "local-user", role: "member" },
    { teamId: "mine", userId: "test-member", role: "member" },
  ]);
  const definition = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "step", type: "tool", service: "demo", action: "ping", params: {} }], edges: [{ from: "trigger", to: "step" }] };
  await p.db.insert(workflowDefinitions).values({ id: "wf-borrow", orgId: "local-org", ownerType: "team", ownerId: "mine", name: "Borrow", definition, createdAt: 1, updatedAt: 1 });
  await p.workflowStore.createRun("run-borrow", { workflowId: "wf-borrow", definitionVersionId: "v1" }, definition, "v1",
    { ownerType: "team", ownerId: "mine", actorUserId: "local-user" });
  // What the tool step stores when it parks on another member's account.
  await p.workflowStore.putIntent({
    runId: "run-borrow", nodeId: "step", iteration: 0, status: "intent", attempt: 1, createdAt: 1,
    effects: { gate: true, provenance: "shared_account", approver: { userId: "test-member", name: "Test Member" } },
  });
  await p.workflowStore.parkRun("run-borrow", 1, [{ kind: "signal", nodeId: "step", signalType: "approval:step" }]);
  const deps = {
    db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost,
    credentials: p.engineCredentials, engineStore: p.engineStore, actionPluginByService: p.actionPluginByService,
  };
  const as = (userId: string) => ({ userId, orgId: "local-org" });

  const detail = await getWorkflowRunDetail(deps, as("local-user"), "run-borrow");
  expect(detail?.pendingGates).toEqual([expect.objectContaining({ nodeId: "step", approver: { userId: "test-member", name: "Test Member" } })]);

  const approve = (userId: string) => resolveWorkflowApproval(deps, as(userId), { runId: "run-borrow", nodeId: "step", approved: true, scope: "run", via: "web" });
  expect(await approve("local-user")).toBe("not_approver");
  expect(await hasBorrowGrant(p.db, { sessionId: "wf:run-borrow", service: "demo", memberId: "test-member" })).toBe(false);
  expect(await approve("test-member")).toBe("ok");
  expect(await hasBorrowGrant(p.db, { sessionId: "wf:run-borrow", service: "demo", memberId: "test-member" })).toBe(true);
});

it("does not reuse a borrow grant across organizations or conversations", async () => {
  api = await bootTestApi();
  const db = api.providers.db;
  await db.insert(teams).values({ id: "borrow-scope-team", orgId: "local-org", name: "Borrow", createdAt: 1 });
  await db.insert(teamMembers).values({ teamId: "borrow-scope-team", userId: "local-user", role: "member" });
  const scope = { sessionId: "borrow-scope-session", threadId: "one", service: "linear", memberId: "test-member" };
  await writeBorrowGrant(db, "local-org", scope);
  const borrower = { ...scope, orgId: "local-org", teamId: "borrow-scope-team", actorId: "local-user" };
  expect(await canBorrowCredential(db, borrower)).toBe(true);
  expect(await canBorrowCredential(db, { ...borrower, orgId: "other-org" })).toBe(false);
  expect(await canBorrowCredential(db, { ...borrower, threadId: "two" })).toBe(false);
});

it("lets an unattended workflow borrow only for its stored team and current lender", async () => {
  api = await bootTestApi();
  const { db, workflowStore } = api.providers;
  await db.insert(teams).values({ id: "unattended", orgId: "local-org", name: "Unattended", createdAt: 1 });
  await db.insert(teamMembers).values({ teamId: "unattended", userId: "test-member", role: "member" });
  await db.insert(workflowDefinitions).values({ id: "webhook-wf", orgId: "local-org", ownerType: "team", ownerId: "unattended", name: "Webhook", definition: {}, createdAt: 1, updatedAt: 1 });
  await workflowStore.createRun("webhook-borrow", { workflowId: "webhook-wf", definitionVersionId: "v1" }, {}, "v1",
    { ownerType: "team", ownerId: "unattended" });
  const scope = { sessionId: "wf:webhook-borrow:step", service: "linear", memberId: "test-member",
    orgId: "local-org", teamId: "unattended", actorId: "team:unattended" };
  expect(await canBorrowCredential(db, scope)).toBe(false);
  await writeBorrowGrant(db, "local-org", scope);
  expect(await canBorrowCredential(db, scope)).toBe(true);
  expect(await canBorrowCredential(db, { ...scope, orgId: "elsewhere" })).toBe(false);
  expect(await canBorrowCredential(db, { ...scope, teamId: "elsewhere", actorId: "team:elsewhere" })).toBe(false);
  expect(await canBorrowCredential(db, { ...scope, actorId: "outsider" })).toBe(false);
  expect(await canBorrowCredential(db, { ...scope, sessionId: "assistant:unattended" })).toBe(false);
  await db.delete(teamMembers).where(eq(teamMembers.teamId, "unattended"));
  expect(await canBorrowCredential(db, scope)).toBe(false);
});
