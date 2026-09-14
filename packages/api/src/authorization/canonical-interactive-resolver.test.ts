import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionPlugin, PolicyResolveInput, ValetPlugin } from "@valet/engine";
import {
  actionPolicies,
  authorizationExecutionAttempts,
  canonicalApprovalResolutions,
  orgMembers,
  orgs,
  policyActiveBundles,
  runtimeGrants,
  users,
} from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalInteractivePolicyResolver } from "./canonical-interactive-resolver.js";
import { CanonicalPolicyBundleManager } from "./canonical-policy-manager.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

function plugins(riskLevel: "low" | "critical") {
  const actionPlugin: ActionPlugin = { service: "github", safeParameterProjection: { schemaVersion: 1, mode: "all_safe" }, actions: [{ id: riskLevel === "critical" ? "github.merge_pull_request" : "github.create_issue", name: "Action", description: "Action", riskLevel, parameters: Type.Object({ value: Type.String() }), execute: async () => ({ success: true }) }] };
  const plugin = { name: "github", version: "1", actions: [actionPlugin] } as ValetPlugin;
  return new Map([["github", { plugin, actionPlugin }]]);
}

function input(riskLevel: "low" | "critical"): PolicyResolveInput {
  return { service: "github", actionId: riskLevel === "critical" ? "github.merge_pull_request" : "github.create_issue", riskLevel, params: { value: "x" }, userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", appliesIn: "session", owner: { type: "user", id: "user-1" }, queueItemId: "queue-1", resumeKey: "call-1", gateOrdinal: 0 };
}

describe("canonicalInteractivePolicyResolver", () => {
  it("durably reserves allows and re-evaluates exact approved requests", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const map = plugins("critical"); const manager = new CanonicalPolicyBundleManager(pg.appDb, map, () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      let clock = 30;
      const resolver = canonicalInteractivePolicyResolver({ db: pg.appDb, service: await CanonicalAuthorizationService.create(manager, () => 20), plugins: map, clock: () => clock });
      const pending = await resolver.resolve(input("critical")); expect(pending.mode).toBe("require_approval");
      await resolver.onResolution!(input("critical"), pending, { actionId: "approve", resolvedBy: "user-2", resolvedAt: 31, gateOrdinal: 1 });
      clock = 32;
      const allowed = await resolver.resolve(input("critical")); expect(allowed.mode).toBe("allow");
      expect(await pg.appDb.select().from(canonicalApprovalResolutions)).toHaveLength(1);
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(1);
    } finally { await manager.close(); }
  }, 120_000);

  it.each([
    ["deny", false, 0, 0, 0, 0],
    ["approve", false, 1, 0, 0, 0],
    ["approve_session", false, 0, 1, 0, 0],
    ["always_allow", false, 0, 0, 1, 1],
    ["malformed", true, 0, 0, 0, 0],
  ] as const)(
    "applies resolution %s with only its required mutation",
    async (actionId, rejects, approvals, grants, policies, generationDelta) => {
      pg = await freshTestPgDb();
      await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
      await pg.appDb.insert(users).values({ id: "user-2", name: "Admin", email: "admin@example.com", emailVerified: true, createdAt: new Date(1), updatedAt: new Date(1) });
      await pg.appDb.insert(orgMembers).values({ orgId: "org-1", userId: "user-2", role: "admin", createdAt: 1 });
      const map = plugins("critical");
      const manager = new CanonicalPolicyBundleManager(pg.appDb, map, () => 10);
      try {
        await manager.ensureOrganizationReady("org-1");
        const resolver = canonicalInteractivePolicyResolver({
          db: pg.appDb,
          service: await CanonicalAuthorizationService.create(manager, () => 20),
          plugins: map,
          clock: () => 30,
        });
        const pending = await resolver.resolve(input("critical"));
        expect(pending.mode).toBe("require_approval");
        const before = (await pg.appDb.select().from(policyActiveBundles))[0]!;
        const resolution = { actionId, resolvedBy: "user-2", resolvedAt: 31, gateOrdinal: 1 };
        if (rejects) await expect(resolver.onResolution!(input("critical"), pending, resolution)).rejects.toThrow("Canonical approval was not approved.");
        else await expect(resolver.onResolution!(input("critical"), pending, resolution)).resolves.toBeUndefined();
        expect(await pg.appDb.select().from(canonicalApprovalResolutions)).toHaveLength(approvals);
        expect(await pg.appDb.select().from(runtimeGrants)).toHaveLength(grants);
        expect(await pg.appDb.select().from(actionPolicies)).toHaveLength(policies);
        const after = (await pg.appDb.select().from(policyActiveBundles))[0]!;
        expect(after.generation).toBe(before.generation + generationDelta);
      } finally {
        await manager.close();
      }
    },
    120_000,
  );
});
