import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionPlugin, CredentialOwner, CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { authorizationDecisions, authorizationExecutionAttempts, actionPolicies, orgs } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { CanonicalPolicyBundleManager } from "../authorization/canonical-policy-manager.js";
import { CanonicalAuthorizationService } from "../authorization/canonical-authorization-service.js";
import { buildActionInvoker } from "./action-invoker.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });
const credentials: CredentialStore = { get: async (_owner: CredentialOwner, _service: string) => null, save: async () => {}, delete: async () => {}, list: async () => [] };

function catalog(execute: ActionPlugin["actions"][number]["execute"]) {
  const actionPlugin: ActionPlugin = { service: "github", actions: [{ id: "github.create_issue", name: "Create", description: "Create", riskLevel: "medium", parameters: Type.Object({ title: Type.String() }), execute }] };
  const plugin = { name: "github", version: "1", actions: [actionPlugin] } as ValetPlugin;
  return new Map([["github", { plugin, actionPlugin }]]);
}

describe("canonical workflow action invocation", () => {
  it("persists the decision and attempt before dispatch and denies changed policy", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const execute = vi.fn(async () => ({ success: true, data: { ok: true } })); const plugins = catalog(execute);
    const manager = new CanonicalPolicyBundleManager(pg.appDb, plugins, () => 10);
    try {
      await manager.ensureOrganizationReady("org-1"); const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const invoke = buildActionInvoker({ db: pg.appDb, credentials, actionPluginByService: plugins, canonicalAuthorizationService: service, clock: () => 30 });
      const context = { userId: "user-1", orgId: "org-1", owner: { type: "user" as const, id: "user-1" }, workflowExecutionId: "run-1", workflowDefinitionId: "workflow-1", workflowVersion: "version-1", workflowNodeId: "node-1" };
      expect(await invoke({ service: "github", action: "create_issue", params: { title: "One" }, invocationId: "workflow:run-1:node-1" }, context)).toEqual({ ok: true, result: { ok: true } });
      expect(execute).toHaveBeenCalledOnce(); expect(await pg.appDb.select().from(authorizationDecisions)).toHaveLength(1); expect((await pg.appDb.select().from(authorizationExecutionAttempts))[0]?.outcome).toBe("completed");
      await manager.mutateAndActivate("org-1", { actorId: "admin", operation: "deny", idempotencyKey: "deny" }, (tx) => tx.insert(actionPolicies).values({ id: "deny", orgId: "org-1", principalType: "org", principalId: "org-1", actionId: "github.create_issue", mode: "deny", paramMatchers: [], appliesIn: "workflow", origin: "admin", createdAt: 31, updatedAt: 31 }));
      expect((await invoke({ service: "github", action: "create_issue", params: { title: "Two" }, invocationId: "workflow:run-1:node-2" }, { ...context, workflowNodeId: "node-2" })).ok).toBe(false);
      expect(execute).toHaveBeenCalledOnce();
    } finally { await manager.close(); }
  }, 120_000);
});
