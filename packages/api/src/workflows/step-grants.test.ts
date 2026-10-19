import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueItem } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, credentials, teamMembers, teams, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { canBorrowCredential } from "../services/credential-borrow.js";
import { revokeShare, shareCredential } from "../services/credential-shares.js";
import { saveWorkflowAccountConsent } from "../services/workflow-account-consent.js";
import { resolveWorkflowStepGrant, workflowStepOf } from "./step-grants.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const definition = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "agent", type: "session", mode: "start", prompt: "Post the summary.", toolScope: { actions: ["demo.ping", "demo.*", "slack.send_message"] } },
    { id: "thread", type: "orchestrator", prompt: "Summarize.", toolScope: { actions: ["demo.ping"] } },
    { id: "each", type: "foreach", items: "{{trigger.data.items}}", body: { id: "each-agent", type: "session", mode: "start", prompt: "Go.", toolScope: { actions: ["demo.ping"] } } },
    { id: "tool", type: "tool", service: "demo", action: "ping", params: {} },
  ],
  edges: [{ from: "trigger", to: "agent" }],
};

function queueItem(id: string, metadata: Record<string, unknown>): QueueItem {
  return { id, threadId: "thread-1", content: "run", metadata, status: "running", attemptCount: 0, maxAttempts: 10, timeoutAt: 0, createdAt: 0, updatedAt: 0 };
}

async function fixture() {
  api = await bootTestApi();
  const { db, workflowStore } = api.providers;
  await db.insert(teams).values({ id: "step-team", orgId: "local-org", name: "Steps", createdAt: 1 });
  await db.insert(teamMembers).values([{ teamId: "step-team", userId: "local-user", role: "admin" }, { teamId: "step-team", userId: "test-member", role: "member" }]);
  await db.insert(workflowDefinitions).values({ id: "step-workflow", orgId: "local-org", ownerType: "team", ownerId: "step-team", name: "Steps", definition, createdAt: 1, updatedAt: 1 });
  await workflowStore.createRun("step-run", { workflowId: "step-workflow", definitionVersionId: "v1" }, definition, "v1",
    { ownerType: "team", ownerId: "step-team", actorUserId: "local-user" });
  const items = new Map([["stamped", queueItem("stamped", { workflowStep: { runId: "step-run", nodeId: "thread" } })]]);
  const deps = { db, engineStore: { getQueueItem: async (_sessionId: string, id: string) => items.get(id) ?? null },
    credentialServiceFor: (service: string) => service };
  const input = { orgId: "local-org", sessionId: "wf:step-run:agent", teamId: "step-team", userId: "local-user" };
  return { db, deps, input };
}

describe("workflowStepOf", () => {
  it("reads the host stamp first, then a session step's id", () => {
    expect(workflowStepOf("assistant-session", { workflowStep: { runId: "r1", nodeId: "n1" } })).toEqual({ runId: "r1", nodeId: "n1" });
    expect(workflowStepOf("wf:r1:n1:2", undefined)).toEqual({ runId: "r1", nodeId: "n1" });
  });
  it("ignores a tool step's run scope and malformed stamps", () => {
    expect(workflowStepOf("wf:r1", undefined)).toBeUndefined();
    expect(workflowStepOf("assistant-session", { workflowStep: { runId: "../r1", nodeId: "n1" } })).toBeUndefined();
    expect(workflowStepOf("assistant-session", { workflowStep: "wf:r1:n1" })).toBeUndefined();
  });
});

describe("resolveWorkflowStepGrant", () => {
  it("returns a session step's exact actions and declared services", async () => {
    const { deps, input } = await fixture();
    expect(await resolveWorkflowStepGrant(deps, input)).toEqual({ workflowId: "step-workflow", runId: "step-run",
      actions: ["demo.ping", "slack.send_message"], services: ["demo", "slack"] });
  });

  it("reads a Thread step from its stamped submission and a foreach body by its own id", async () => {
    const { db, deps, input } = await fixture();
    await db.insert(agentSessions).values({ id: "team-assistant", orgId: "local-org", ownerType: "team", ownerId: "step-team", userId: "local-user", workspace: "test", createdAt: 1, updatedAt: 1 });
    expect(await resolveWorkflowStepGrant(deps, { ...input, sessionId: "team-assistant", queueItemId: "stamped", userId: "team:step-team" }))
      .toMatchObject({ runId: "step-run", actions: ["demo.ping"] });
    expect(await resolveWorkflowStepGrant(deps, { ...input, sessionId: "wf:step-run:each-agent:3" })).toMatchObject({ actions: ["demo.ping"] });
  });

  it("refuses a team run's Thread step in a member's personal assistant", async () => {
    const { db, deps, input } = await fixture();
    await db.insert(agentSessions).values({ id: "personal-assistant", orgId: "local-org", ownerType: "user", ownerId: "local-user", userId: "local-user", workspace: "test", createdAt: 1, updatedAt: 1 });
    expect(await resolveWorkflowStepGrant(deps, { ...input, sessionId: "personal-assistant", queueItemId: "stamped" })).toBeUndefined();
  });

  it.each([
    ["a tool step", async () => ({ sessionId: "wf:step-run:tool" })],
    ["a missing run", async () => ({ sessionId: "wf:other-run:agent" })],
    ["another org", async () => ({ orgId: "other-org" })],
  ])("refuses %s", async (_name, change) => {
    const { deps, input } = await fixture();
    expect(await resolveWorkflowStepGrant(deps, { ...input, ...(await change()) })).toBeUndefined();
  });

  it.each([
    ["a settled run", "settled"],
    ["a run an agent started", "agent-start"],
    ["changed steps", "edit"],
    ["a new owner", "owner"],
  ] as const)("refuses %s", async (_name, change) => {
    const { db, deps, input } = await fixture();
    if (change === "settled") await db.update(workflowRuns).set({ status: "settled" }).where(eq(workflowRuns.id, "step-run"));
    if (change === "agent-start") await db.update(workflowRuns).set({ params: { workflowId: "step-workflow", definitionVersionId: "v1", startedBy: "agent" } }).where(eq(workflowRuns.id, "step-run"));
    if (change === "edit") await db.update(workflowDefinitions).set({ definition: { ...definition, nodes: definition.nodes.slice(0, 2) } }).where(eq(workflowDefinitions.id, "step-workflow"));
    if (change === "owner") await db.update(workflowDefinitions).set({ ownerType: "user", ownerId: "local-user" }).where(eq(workflowDefinitions.id, "step-workflow"));
    expect(await resolveWorkflowStepGrant(deps, input)).toBeUndefined();
  });
});

describe("account consent in an agent step", () => {
  async function lent() {
    const setup = await fixture();
    await shareCredential(setup.db, { teamId: "step-team", service: "demo", userId: "test-member", createdAt: 1 });
    await setup.db.insert(credentials).values({ ownerType: "user", ownerId: "test-member", service: "demo", type: "api_key", apiKeyEnc: "test", createdAt: 1, updatedAt: 1 });
    await setup.db.insert(agentSessions).values({ id: "team-assistant", orgId: "local-org", ownerType: "team", ownerId: "step-team", userId: "local-user", workspace: "test", createdAt: 1, updatedAt: 1 });
    await saveWorkflowAccountConsent(setup.db, { orgId: "local-org", workflowId: "step-workflow", teamId: "step-team", userId: "test-member", services: ["demo"] });
    const scope = { orgId: "local-org", teamId: "step-team", service: "demo", memberId: "test-member", actorId: "team:step-team", sessionId: "team-assistant", threadId: "thread-1" };
    const step = await resolveWorkflowStepGrant(setup.deps, { ...setup.input, sessionId: "team-assistant", queueItemId: "stamped", userId: "team:step-team" });
    return { ...setup, scope, step };
  }

  it("lets a Thread step borrow the lender's account that the lender saved for this workflow", async () => {
    const { db, scope, step } = await lent();
    expect(await canBorrowCredential(db, scope)).toBe(false);
    expect(await canBorrowCredential(db, { ...scope, ...(step ? { step } : {}) })).toBe(true);
  });

  it("refuses a service the step does not declare", async () => {
    const { db, scope, step } = await lent();
    expect(step).toBeDefined();
    expect(await canBorrowCredential(db, { ...scope, ...(step ? { step: { ...step, services: ["slack"] } } : {}) })).toBe(false);
  });

  it("refuses after the lender stops sharing", async () => {
    const { db, scope, step } = await lent();
    await revokeShare(db, { teamId: "step-team", service: "demo", userId: "test-member" });
    await shareCredential(db, { teamId: "step-team", service: "demo", userId: "test-member", createdAt: 2 });
    expect(await canBorrowCredential(db, { ...scope, ...(step ? { step } : {}) })).toBe(false);
  });
});
