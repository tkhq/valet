import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionPlugin, PolicyResolveInput, ValetPlugin } from "@valet/engine";
import { authorizationExecutionAttempts, canonicalApprovalResolutions, orgs } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalInteractivePolicyResolver } from "./canonical-interactive-resolver.js";
import { CanonicalPolicyBundleManager } from "./canonical-policy-manager.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

function plugins(riskLevel: "low" | "critical") {
  const actionPlugin: ActionPlugin = { service: "github", actions: [{ id: riskLevel === "critical" ? "github.merge_pull_request" : "github.create_issue", name: "Action", description: "Action", riskLevel, parameters: Type.Object({ value: Type.String() }), execute: async () => ({ success: true }) }] };
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
});
