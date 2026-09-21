import { afterEach, describe, expect, it } from "vitest";
import { adaptApiRoute } from "@valet/engine/authorization";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { actionPolicies, authorizationDecisions, canonicalApprovalResolutions, orgs } from "../schema/index.js";
import { CanonicalPolicyBundleManager } from "./canonical-policy-manager.js";
import { CanonicalAuthorizationService, canonicalDecisionId } from "./canonical-authorization-service.js";
import { loadApprovedRouteReplay } from "./route-resource-policy.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

const descriptor = {
  schemaVersion: 1 as const, service: "api_sessions", actionId: "api_sessions.get_sessions_item",
  method: "GET", routeTemplate: "/api/sessions/:id", riskLevel: "low",
};

function initial(action = descriptor, requestId = "http-request-1", operationId = "http-delivery-1", safeRequestFingerprint = "a".repeat(64)) {
  return adaptApiRoute({
    schemaVersion: 1, organizationId: "org-1", actorUserId: "user-1",
    principal: { type: "user", id: "user-1" }, requestId,
    operationId, evaluationTimeMs: 100, descriptor: action, safeMetadata: { safeRequestFingerprint },
  });
}

describe("durable route approval replay", () => {
  it("re-evaluates an exact approved route and rejects a changed route", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    await pg.appDb.insert(actionPolicies).values({
      id: "route-approval", orgId: "org-1", authorizationKind: "api.route", principalType: "org",
      principalId: "org-1", actionId: descriptor.actionId, mode: "require_approval", paramMatchers: [],
      appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2,
    });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 200);
      const first = initial();
      const decision = await service.authorize(first.request);
      expect(decision.decision.effect).toBe("require_approval");
      const row = (await pg.appDb.select().from(authorizationDecisions))[0]!;
      const resolutionId = "resolution-route-1";
      await pg.appDb.insert(canonicalApprovalResolutions).values({
        resolutionId, approvalId: row.decisionId, gateId: row.decisionId, orgId: row.orgId,
        requestSubjectDigest: row.requestSubjectDigest, originalDecisionDigest: row.evidence!.decisionDigest,
        approverId: "admin-1", verdict: "approved", appliesIn: "route", scopeKind: "route", scopeId: first.request.subject.invocation.id,
        resolvedAt: 150, expiresAt: 500, resolutionVersion: 1,
      });
      const retry = initial(descriptor, "http-request-2", "http-delivery-2");
      const replay = await loadApprovedRouteReplay(pg.appDb, retry.request, resolutionId, 200, (stored) => service.verifyPersistedDecision(stored));
      expect(replay?.verdict).toBe("approved");
      const post = adaptApiRoute({
        schemaVersion: 1, organizationId: "org-1", actorUserId: "user-1", principal: { type: "user", id: "user-1" },
        requestId: "http-request-approved", operationId: replay!.operationId, evaluationTimeMs: 200, descriptor,
        dynamicFacts: { currentPolicy: replay!.facts }, approvalBindingContext: replay!.binding,
        approvalScopeId: replay!.scopeId, safeMetadata: { safeRequestFingerprint: "a".repeat(64) },
      });
      expect((await service.authorize(post.request)).decision).toMatchObject({ effect: "allow", reasonCode: "dynamic_grant" });
      expect(canonicalDecisionId("org-1", first.request.idempotencyKey)).toBe(row.decisionId);
      const changed = initial({ ...descriptor, actionId: "api_sessions.get_sessions_other" });
      await expect(loadApprovedRouteReplay(pg.appDb, changed.request, resolutionId, 200)).rejects.toThrow(/does not match/i);
      const changedSemantics = initial(descriptor, "http-request-3", "http-delivery-3", "b".repeat(64));
      await expect(loadApprovedRouteReplay(pg.appDb, changedSemantics.request, resolutionId, 200)).rejects.toThrow(/does not match/i);
      await pg.appDb.update(canonicalApprovalResolutions).set({ revokedAt: 201 });
      await expect(loadApprovedRouteReplay(pg.appDb, first.request, resolutionId, 202)).rejects.toThrow(/does not match/i);
      await pg.appDb.update(canonicalApprovalResolutions).set({ revokedAt: null });
      await expect(loadApprovedRouteReplay(pg.appDb, first.request, resolutionId, 500)).rejects.toThrow(/does not match/i);
      await pg.appDb.update(authorizationDecisions).set({ evaluatorEngineDigest: "0".repeat(64) });
      await expect(loadApprovedRouteReplay(pg.appDb, first.request, resolutionId, 200, (stored) => service.verifyPersistedDecision(stored))).rejects.toThrow(/evidence is invalid/i);
    } finally { await manager.close(); }
  }, 120_000);
});
