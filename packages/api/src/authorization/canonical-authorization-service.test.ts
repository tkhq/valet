import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { adaptInteractiveAction, adaptWorkflowAction } from "@valet/engine/authorization";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { actionPolicies, authorizationDecisions, orgs, teams } from "../schema/index.js";
import { CanonicalPolicyBundleManager, type CanonicalOverrideBoundPolicyReference } from "./canonical-policy-manager.js";
import { CanonicalAuthorizationService } from "./canonical-authorization-service.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

function plugins() {
  const actionPlugin: ActionPlugin = { service: "github", safeParameterProjection: { schemaVersion: 1, mode: "all_safe" }, actions: [{ id: "github.create_issue", name: "Create issue", description: "Create issue", riskLevel: "medium", parameters: Type.Object({}), execute: async () => ({ success: true }) }] };
  const plugin = { name: "github", version: "1", actions: [actionPlugin] } as ValetPlugin;
  return new Map([["github", { plugin, actionPlugin }]]);
}

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

  it("stores only digest evidence for large allow, deny, and approval inputs", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    await pg.appDb.insert(actionPolicies).values({ id: "deny-large", orgId: "org-1", principalType: "org", principalId: "org-1", actionId: "gmail.deny_large", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 200);
      const large = (effect: string) => `CANARY-${effect}-${"x".repeat(60 * 1024)}`;
      const authorize = async (effect: "allow" | "deny" | "gate", riskLevel: "low" | "high") => {
        const adapted = adaptInteractiveAction({
          schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" }, requestId: `request-${effect}`,
          sessionId: "session-1", threadId: "thread-1", queueItemId: `queue-${effect}`, resumeKey: `resume-${effect}`, gateOrdinal: 0,
          action: { service: "gmail", actionId: effect === "deny" ? "gmail.deny_large" : `gmail.${effect}_large`, catalogActionId: effect === "deny" ? "gmail.deny_large" : `gmail.${effect}_large`, sourcePluginService: "gmail", sourceActionId: effect === "deny" ? "gmail.deny_large" : `gmail.${effect}_large`, sourceToolId: "call_tool", riskLevel, parameters: { value: large(effect) }, parameterProjection: { schemaVersion: 1, mode: "all_safe" } },
          evaluationTimeMs: 100, dynamicFacts: {},
        });
        return service.authorize(adapted.request);
      };
      expect((await authorize("allow", "low")).decision.effect).toBe("allow");
      expect((await authorize("deny", "low")).decision.effect).toBe("deny");
      expect((await authorize("gate", "high")).decision.effect).toBe("require_approval");

      const rows = await pg.appDb.select().from(authorizationDecisions);
      expect(rows).toHaveLength(3);
      const stored = JSON.stringify(rows);
      for (const effect of ["allow", "deny", "gate"]) {
        expect(stored).not.toContain(`CANARY-${effect}-`);
        expect(stored).not.toContain(large(effect));
      }
      expect(rows.find((row) => row.effect === "allow")?.evidence).not.toHaveProperty("approvalReplay");
      expect(rows.find((row) => row.effect === "deny")?.evidence).not.toHaveProperty("approvalReplay");
      expect(rows.find((row) => row.effect === "require_approval")?.evidence?.approvalReplay).toEqual({ evaluationTimeMs: 100 });
      for (const row of rows) expect(row.evidence).not.toHaveProperty("request");
    } finally { await manager.close(); }
  }, 120_000);

  it.each([
    ["blocks a broad service allow for an absent org action", "org", { actionId: "future.hidden" }, { service: "future" }, null, false],
    ["blocks a broad risk allow for an absent team action", "team", { actionId: "future.hidden" }, { riskLevel: "high" }, null, false],
    ["permits a provably disjoint service allow", "org", { actionId: "slack.hidden" }, { service: "github" }, null, true],
    ["ignores a revoked absent action reference", "org", { actionId: "future.hidden" }, { service: "future" }, 9, true],
    ["keeps a known action at its catalog risk", "org", { riskLevel: "critical" }, { actionId: "github.create_issue" }, null, true],
    ["keeps a matching catalog risk bound", "org", { riskLevel: "medium" }, { actionId: "github.create_issue" }, null, false],
  ] as const)("%s", async (_name, principalType, policyTarget, overrideTarget, revokedAt, expected) => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    await pg.appDb.insert(teams).values({ id: "team-1", orgId: "org-1", name: "Team", createdAt: 1 });
    await pg.appDb.insert(actionPolicies).values({ id: "bound", orgId: "org-1", principalType, principalId: principalType === "org" ? "org-1" : "team-1", ...policyTarget, mode: "require_approval", paramMatchers: [], appliesIn: "any", origin: "admin", revokedAt, createdAt: 2, updatedAt: 2 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, plugins(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 200);
      let boundsIdentity!: { sourceBundleDigest: string; policyDigest: string };
      let policyReferences: readonly CanonicalOverrideBoundPolicyReference[] = [];
      await manager.mutateAndActivate("org-1", { actorId: "user-1", operation: "bounds_test", idempotencyKey: "bounds" }, async (_tx, context) => {
        boundsIdentity = await context.overrideBoundsIdentity();
        policyReferences = context.overrideBoundPolicyReferences();
      });
      expect((await service.validateOverrideBounds("org-1", "user-1", overrideTarget, "allow", boundsIdentity, policyReferences)).ok).toBe(expected);
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
