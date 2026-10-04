import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { teamMembers, teams, workflowDefinitions } from "../schema/index.js";
import { getWorkflowRunDetail, resolveWorkflowApproval } from "../workflows/service.js";
import { hasBorrowGrant } from "./credential-borrow.js";

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
