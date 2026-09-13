import { afterEach, describe, expect, it } from "vitest";
import { adaptWorkflowAction } from "@valet/engine/authorization";
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
      expect(await pg.appDb.select().from(authorizationDecisions)).toHaveLength(1);
      await expect(service.authorize(request({ value: 2 }))).rejects.toThrow(/idempotency conflict/);
    } finally { await manager.close(); }
  }, 120_000);
});
