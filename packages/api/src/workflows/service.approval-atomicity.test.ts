import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionInvocations, credentials, credentialShares, runtimeGrants, teamMembers, teams, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { revokeShare, shareCredential } from "../services/credential-shares.js";
import * as borrow from "../services/credential-borrow.js";
import * as policy from "../policies/service.js";
import { getWorkflowRunDetail, listWorkflowActionRequired, resolveWorkflowApproval } from "./service.js";

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

it("keeps the borrow approver check while a claimed run still waits on the gate", async () => {
  const { p, wake } = await setup();
  await p.workflowStore.claimRun("run-atomic", "host", 30_000);
  const result = await resolveWorkflowApproval({ db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore },
    { userId: "local-user", orgId: "local-org", principal: { type: "team", id: "atomic-team" } },
    { runId: "run-atomic", nodeId: "step", approved: true, via: "web" });
  expect(result).toBe("not_approver");
  expect(await p.workflowStore.listSignals("run-atomic")).toEqual([]);
  expect(wake).not.toHaveBeenCalled();
});

it("accepts a second gate's answer after the first answer wakes the run", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await p.db.insert(teams).values({ id: "t2", orgId: "local-org", name: "T2", createdAt: 1 });
  await p.db.insert(teamMembers).values({ teamId: "t2", userId: "local-user", role: "member" });
  const definition = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "a", type: "tool", service: "demo", action: "ping", params: {} }, { id: "b", type: "tool", service: "demo", action: "pong", params: {} }],
    edges: [{ from: "trigger", to: "a" }, { from: "trigger", to: "b" }] };
  await p.db.insert(workflowDefinitions).values({ id: "wf-two", orgId: "local-org", ownerType: "team", ownerId: "t2", name: "Two gates", definition, createdAt: 1, updatedAt: 1 });
  await p.workflowStore.createRun("run-two", { workflowId: "wf-two", definitionVersionId: "v1" }, definition, "v1", { ownerType: "team", ownerId: "t2", actorUserId: "local-user" });
  await p.workflowStore.parkRun("run-two", 1, [{ kind: "signal", nodeId: "a", signalType: "approval:a" }, { kind: "signal", nodeId: "b", signalType: "approval:b" }]);
  // The run host claims the run as soon as gate a's answer wakes it.
  vi.spyOn(p.workflowRunHost, "wake").mockImplementation(async (runId) => { await p.workflowStore.claimRun(runId, "host", 30_000); });
  const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore, actionPluginByService: p.actionPluginByService };
  const answer = (nodeId: string) => resolveWorkflowApproval(deps, { userId: "local-user", orgId: "local-org" }, { runId: "run-two", nodeId, approved: true, scope: "once", via: "web" });
  expect(await answer("a")).toBe("ok");
  expect((await p.workflowStore.getRun("run-two"))?.status).toBe("running");
  expect(await answer("b")).toBe("ok");
  expect((await p.workflowStore.listSignals("run-two", { unconsumed: true })).map(s => s.signalType)).toEqual(["approval:a", "approval:b"]);
  // An answer for a node the run does not wait on still fails.
  expect(await answer("trigger")).toBe("not_parked");
  // If the drive re-parks before it reads b's answer, the sweep wakes the run.
  // Meanwhile the answered gate is not listed as waiting.
  await p.workflowStore.parkRun("run-two", 2, [{ kind: "signal", nodeId: "b", signalType: "approval:b" }]);
  expect((await listWorkflowActionRequired(deps, { userId: "local-user", orgId: "local-org" })).items).toEqual([]);
});


it.each([false, true])("grants lasting account consent only for a verified person (verified=%s)", async verified => {
  const { p } = await setup();
  await p.db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "demo", type: "api_key", apiKeyEnc: "test", createdAt: 1, updatedAt: 1 });
  const checkpoint = (await p.workflowStore.getCheckpoints("run-atomic"))[0]!;
  await p.workflowStore.putIntent({ ...checkpoint, effects: { ...checkpoint.effects, approver: { userId: "local-user", shareGeneration: await borrow.shareGeneration(p.db, "atomic-team", "demo", "local-user"), allowTeamConsent: true } } });
  const outcome = await resolveWorkflowApproval({ db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore },
    { userId: "local-user", orgId: "local-org", humanAccountConsent: verified },
    { runId: "run-atomic", nodeId: "step", approved: true, scope: "team_account", via: "web" });
  expect(outcome).toBe(verified ? "ok" : "human_only");
  const [share] = await p.db.select().from(credentialShares);
  expect(share?.borrowConsentAt != null).toBe(verified);
  expect(await p.db.select().from(runtimeGrants)).toEqual([]);
  if (verified) {
    expect((await p.workflowStore.listSignals("run-atomic"))[0]).toMatchObject({ signalId: `approval:step:account:${await borrow.shareGeneration(p.db, "atomic-team", "demo", "local-user")}:resolution`, payload: { scope: "team_account" } });
    expect((await p.db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run-atomic:step")))[0]?.status).toBe("pending");
  }
});

it("rejects a lasting choice on an old account gate without changing its scope", async () => {
  const { p } = await setup();
  expect(await resolveWorkflowApproval({ db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore },
    { userId: "local-user", orgId: "local-org", humanAccountConsent: true },
    { runId: "run-atomic", nodeId: "step", approved: true, scope: "team_account", via: "web" })).toBe("not_approver");
  expect(await p.workflowStore.listSignals("run-atomic")).toEqual([]);
});


it("keeps a separate action gate visible after consuming lasting account consent", async () => {
  const { p } = await setup();
  const cp = (await p.workflowStore.getCheckpoints("run-atomic"))[0];
  if (!cp) throw new Error("Missing checkpoint");
  await p.workflowStore.insertSignal({ runId: "run-atomic", signalId: "approval:step:account:resolution", signalType: "approval:step", payload: { approved: true, resolvedBy: "local-user", scope: "team_account" }, createdAt: 1 });
  await p.workflowStore.consumeSignalAndCheckpoint("approval:step:account:resolution", { nodeId: "step", iteration: 0, attempt: cp.attempt },
    { ...cp, effects: { gate: true, accountConsentResolved: true, provenance: "org_policy" } });
  const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore };
  expect((await getWorkflowRunDetail(deps, { userId: "local-user", orgId: "local-org" }, "run-atomic"))?.pendingGates).toEqual([expect.objectContaining({ nodeId: "step", provenance: "org_policy" })]);
  expect(await resolveWorkflowApproval(deps, { userId: "local-user", orgId: "local-org" }, { runId: "run-atomic", nodeId: "step", approved: true, scope: "once", via: "web" })).toBe("ok");
  expect(await p.workflowStore.listSignals("run-atomic")).toHaveLength(2);
});


it.each([false, true])("chooses one concurrent answer for a new account gate (firstApproval=%s)", async firstApproval => {
  const { p } = await setup();
  await p.db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "demo", type: "api_key", apiKeyEnc: "test", createdAt: 1, updatedAt: 1 });
  const cp = (await p.workflowStore.getCheckpoints("run-atomic"))[0];
  if (!cp) throw new Error("Missing checkpoint");
  await p.workflowStore.putIntent({ ...cp, effects: { ...cp.effects, approver: { userId: "local-user", allowTeamConsent: true, shareGeneration: await borrow.shareGeneration(p.db, "atomic-team", "demo", "local-user") } } });
  const listSignals = p.workflowStore.listSignals.bind(p.workflowStore);
  let release = () => {};
  const bothRead = new Promise<void>(done => { release = done; });
  let readers = 0;
  const reads = vi.spyOn(p.workflowStore, "listSignals").mockImplementation(async (...args) => {
    const signals = await listSignals(...args);
    if (++readers === 2) release();
    await bothRead;
    return signals;
  });
  const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore };
  const answer = (approved: boolean) => resolveWorkflowApproval(deps, { userId: "local-user", orgId: "local-org", humanAccountConsent: true }, { runId: "run-atomic", nodeId: "step", approved, scope: "team_account", via: "web" });
  expect(await Promise.all([answer(firstApproval), answer(true)])).toEqual(["ok", firstApproval ? "ok" : "already_resolved"]);
  reads.mockRestore();
  expect(await p.workflowStore.listSignals("run-atomic")).toHaveLength(1);
  expect((await p.db.select().from(credentialShares))[0]?.borrowConsentAt != null).toBe(firstApproval);
});


it("resolves a new account gate after revocation and re-sharing before workflow resume", async () => {
  const { p } = await setup();
  await p.db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "demo", type: "api_key", apiKeyEnc: "test", createdAt: 1, updatedAt: 1 });
  const cp = (await p.workflowStore.getCheckpoints("run-atomic"))[0];
  if (!cp) throw new Error("Missing checkpoint");
  const currentApprover = async () => ({ userId: "local-user", allowTeamConsent: true, shareGeneration: await borrow.shareGeneration(p.db, "atomic-team", "demo", "local-user") });
  await p.workflowStore.putIntent({ ...cp, effects: { ...cp.effects, approver: await currentApprover() } });
  const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore };
  const answer = () => resolveWorkflowApproval(deps, { userId: "local-user", orgId: "local-org", humanAccountConsent: true }, { runId: "run-atomic", nodeId: "step", approved: true, scope: "team_account", via: "web" });
  expect(await answer()).toBe("ok");
  const [oldSignal] = await p.workflowStore.listSignals("run-atomic");
  if (!oldSignal) throw new Error("Missing consent signal");
  await revokeShare(p.db, { teamId: "atomic-team", service: "demo", userId: "local-user" });
  await shareCredential(p.db, { teamId: "atomic-team", service: "demo", userId: "local-user", createdAt: 2 });
  await p.workflowStore.consumeSignalAndCheckpoint(oldSignal.signalId, { nodeId: "step", iteration: 0, attempt: cp.attempt },
    { ...cp, effects: { gate: true, accountConsentResolved: true, provenance: "shared_account", approver: await currentApprover() } });
  expect((await getWorkflowRunDetail(deps, { userId: "local-user", orgId: "local-org" }, "run-atomic"))?.pendingGates).toHaveLength(1);
  expect(await answer()).toBe("ok");
  expect(await p.workflowStore.listSignals("run-atomic", { unconsumed: true })).toHaveLength(1);
  expect((await p.db.select().from(credentialShares))[0]?.borrowConsentAt).not.toBeNull();
});
