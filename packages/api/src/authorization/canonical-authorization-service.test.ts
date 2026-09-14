import { afterEach, describe, expect, it } from "vitest";
import { adaptInteractiveAction, adaptWorkflowAction } from "@valet/engine/authorization";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { authorizationDecisions, orgs } from "../schema/index.js";
import { CanonicalPolicyBundleManager } from "./canonical-policy-manager.js";
import { CanonicalAuthorizationService } from "./canonical-authorization-service.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

function request(params: Record<string, unknown>) {
  return adaptWorkflowAction({
    schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" }, requestId: "request-1",
    workflowDefinitionId: "workflow-1", workflowVersion: "version-1", workflowExecutionId: "run-1", nodeId: "node-1", invocationId: "invocation-1",
    action: { service: "gmail", actionId: "gmail.send", catalogActionId: "gmail.send", sourcePluginService: "gmail", sourceActionId: "gmail.send", sourceToolId: "node-1", riskLevel: "low", parameters: params, parameterProjection: { schemaVersion: 1, mode: "all_safe" } },
    evaluationTimeMs: 100, dynamicFacts: {},
  }).request;
}

describe("CanonicalAuthorizationService", () => {
  it("reserves an evaluated decision and replays it exactly", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 200);
      const first = await service.authorize(request({ value: 1 }));
      expect((await service.authorize(request({ value: 1 }))).decision).toEqual(first.decision);
      const restarted = await CanonicalAuthorizationService.create(manager, () => 300);
      expect((await restarted.authorize(request({ value: 1 }))).decision).toEqual(first.decision);
      expect(await pg.appDb.select().from(authorizationDecisions)).toHaveLength(1);
      await expect(service.authorize(request({ value: 2 }))).rejects.toThrow(/idempotency conflict/);
    } finally { await manager.close(); }
  }, 120_000);

  it("returns equal preview decisions for equivalent interactive and workflow actions", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 200);
      const action = { service: "gmail", actionId: "gmail.send", catalogActionId: "gmail.send", sourcePluginService: "gmail", sourceActionId: "gmail.send", sourceToolId: "tool-1", riskLevel: "low" as const, parameters: { value: 1 }, parameterProjection: { schemaVersion: 1 as const, mode: "all_safe" as const } };
      const interactive = adaptInteractiveAction({ schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" }, requestId: "interactive-1", sessionId: "scope-1", threadId: "thread-1", queueItemId: "item-1", resumeKey: "resume-1", gateOrdinal: 0, action, evaluationTimeMs: 100, dynamicFacts: {} });
      const workflow = adaptWorkflowAction({ schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" }, requestId: "workflow-1", workflowDefinitionId: "definition-1", workflowVersion: "1", workflowExecutionId: "scope-1", nodeId: "node-1", invocationId: "invocation-1", action, evaluationTimeMs: 100, dynamicFacts: {} });
      expect((await service.preview(interactive.request)).decision).toEqual((await service.preview(workflow.request)).decision);
      expect(await pg.appDb.select().from(authorizationDecisions)).toHaveLength(0);
    } finally { await manager.close(); }
  }, 120_000);
});
