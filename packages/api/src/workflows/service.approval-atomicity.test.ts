import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionInvocations, runtimeGrants, teamMembers, teams, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { shareCredential } from "../services/credential-shares.js";
import * as borrow from "../services/credential-borrow.js";
import * as policy from "../policies/service.js";
import { resolveWorkflowApproval } from "./service.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); await api?.cleanup(); api = undefined; });

async function setup(sharedAccount = true) {
  api = await bootTestApi();
  const p = api.providers;
  await p.db.insert(teams).values({ id: "atomic-team", orgId: "local-org", name: "Atomic", createdAt: 1 });
  await p.db.insert(teamMembers).values({ teamId: "atomic-team", userId: "local-user", role: "member" });
  const definition = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "step", type: "tool", service: "demo", action: "ping", params: {} }], edges: [{ from: "trigger", to: "step" }] };
  await p.db.insert(workflowDefinitions).values({ id: "wf-atomic", orgId: "local-org", ownerType: "team", ownerId: "atomic-team", name: "Atomic", definition, createdAt: 1, updatedAt: 1 });
  await p.workflowStore.createRun("run-atomic", { workflowId: "wf-atomic", definitionVersionId: "v1" }, definition, "v1", { ownerType: "team", ownerId: "atomic-team", actorUserId: "local-user" });
  await shareCredential(p.db, { teamId: "atomic-team", service: "demo", userId: "local-user", createdAt: 1 });
  if (sharedAccount) await p.workflowStore.putIntent({ runId: "run-atomic", nodeId: "step", iteration: 0, status: "intent", attempt: 1, createdAt: 1,
    effects: { gate: true, provenance: "shared_account", approver: { userId: "local-user", name: "Local User", shareGeneration: await borrow.shareGeneration(p.db, "atomic-team", "demo", "local-user") } } });
  await p.workflowStore.parkRun("run-atomic", 1, [{ kind: "signal", nodeId: "step", signalType: "approval:step" }]);
  await policy.persistInvocationAudit(p.db, { invocationId: "pol:wf:workflow:run-atomic:step", orgId: "local-org", workflowExecutionId: "run-atomic", service: "demo", actionId: "demo.ping", resolvedMode: "require_approval", status: "pending" });
  const wake = vi.spyOn(p.workflowRunHost, "wake").mockResolvedValue(undefined);
  const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore, actionPluginByService: p.actionPluginByService };
  const resolve = (approved: boolean) => resolveWorkflowApproval(deps, { userId: "local-user", orgId: "local-org" }, { runId: "run-atomic", nodeId: "step", approved, scope: "run", via: "web" });
  return { p, wake, resolve };
}

it.each([true, false])("rolls back signal, audit, and wake when the grant fails (borrow=%s), then retries", async shared => {
  const { p, wake, resolve } = await setup(shared);
  const failure = shared ? vi.spyOn(borrow, "writeBorrowGrant") : vi.spyOn(policy, "writeExecutionGrant");
  failure.mockRejectedValueOnce(new Error("injected grant failure"));
  await expect(resolve(true)).rejects.toThrow("injected grant failure");
  expect(await p.workflowStore.listSignals("run-atomic")).toEqual([]);
  expect(await p.db.select().from(runtimeGrants)).toEqual([]);
  expect((await p.db.select().from(actionInvocations))[0]?.status).toBe("pending");
  expect((await p.db.select().from(workflowRuns).where(eq(workflowRuns.id, "run-atomic")))[0]?.wakeRequested).toBe(false);
  expect(wake).not.toHaveBeenCalled();
  expect(await resolve(true)).toBe("ok");
  expect(await p.workflowStore.listSignals("run-atomic")).toHaveLength(1);
  expect(await p.db.select().from(runtimeGrants)).toHaveLength(1);
  expect((await p.db.select().from(actionInvocations))[0]?.status).toBe("approved");
  expect((await p.db.select().from(workflowRuns).where(eq(workflowRuns.id, "run-atomic")))[0]?.wakeRequested).toBe(true);
  expect(wake).toHaveBeenCalledTimes(1);
});

it.each([
  { shared: true, firstApproval: false }, { shared: false, firstApproval: false },
  { shared: true, firstApproval: true }, { shared: false, firstApproval: true },
])("keeps concurrent resolutions consistent (borrow=$shared, firstApproval=$firstApproval)", async ({ shared, firstApproval }) => {
  const { p, wake, resolve } = await setup(shared);
  const listSignals = p.workflowStore.listSignals.bind(p.workflowStore);
  let release = () => {};
  const bothRead = new Promise<void>(done => { release = done; });
  let readers = 0;
  const reads = vi.spyOn(p.workflowStore, "listSignals").mockImplementation(async (...args) => {
    const signals = await listSignals(...args);
    readers++;
    if (readers === 2) release();
    await bothRead;
    return signals;
  });
  // Both callers pass the initial empty-signal check before either transaction.
  expect(await Promise.all([resolve(firstApproval), resolve(true)])).toEqual(["ok", firstApproval ? "ok" : "already_resolved"]);
  reads.mockRestore();
  expect(await p.db.select().from(runtimeGrants)).toHaveLength(firstApproval ? 1 : 0);
  expect((await p.workflowStore.listSignals("run-atomic"))[0]?.payload).toMatchObject({ approved: firstApproval });
  expect((await p.db.select().from(actionInvocations))[0]?.status).toBe(firstApproval ? "approved" : "denied");
  expect(wake).toHaveBeenCalledTimes(firstApproval ? 2 : 1);
});


it("does not let a team principal borrow its minting user's account", async () => {
  const { p, wake } = await setup();
  const result = await resolveWorkflowApproval({ db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore },
    { userId: "local-user", orgId: "local-org", principal: { type: "team", id: "atomic-team" } },
    { runId: "run-atomic", nodeId: "step", approved: true, via: "web" });
  expect(result).toBe("not_approver");
  expect(await p.workflowStore.listSignals("run-atomic")).toEqual([]);
  expect(await p.db.select().from(runtimeGrants)).toEqual([]);
  expect(wake).not.toHaveBeenCalled();
});
