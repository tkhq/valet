import { Type } from "typebox";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionPlugin, CredentialOwner, CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { actionInvocations, authorizationDecisions, authorizationExecutionAttempts, actionPolicies, orgs, policySourceBundles } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { CanonicalPolicyBundleManager } from "../authorization/canonical-policy-manager.js";
import { CanonicalAuthorizationService } from "../authorization/canonical-authorization-service.js";
import { buildActionInvoker } from "./action-invoker.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });
const credentials: CredentialStore = { get: async (_owner: CredentialOwner, _service: string) => null, save: async () => {}, delete: async () => {}, list: async () => [] };

function catalog(execute: ActionPlugin["actions"][number]["execute"], service = "github", actionId = "github.create_issue") {
  const actionPlugin: ActionPlugin = { service, safeParameterProjection: { schemaVersion: 1, mode: "all_safe" }, actions: [{ id: actionId, name: "Create", description: "Create", riskLevel: "medium", parameters: Type.Object({ title: Type.String() }), execute }] };
  const plugin = { name: service, version: "1", actions: [actionPlugin] } as ValetPlugin;
  return new Map([[service, { plugin, actionPlugin }]]);
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

  it("replays completed outcomes and stops indeterminate redelivery", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const execute = vi.fn(async () => ({ success: true, data: { value: "original" } })); const plugins = catalog(execute);
    const manager = new CanonicalPolicyBundleManager(pg.appDb, plugins, () => 10);
    const request = { service: "github", action: "create_issue", params: { title: "One" }, invocationId: "workflow:run-1:replay" };
    const context = { userId: "user-1", orgId: "org-1", owner: { type: "user" as const, id: "user-1" }, workflowExecutionId: "run-1", workflowDefinitionId: "workflow-1", workflowVersion: "version-1", workflowNodeId: "replay" };
    try {
      await manager.ensureOrganizationReady("org-1"); const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const invoke = buildActionInvoker({ db: pg.appDb, credentials, actionPluginByService: plugins, canonicalAuthorizationService: service, clock: () => 30 });
      expect(await invoke(request, context)).toEqual({ ok: true, result: { value: "original" } });
      await pg.appDb.delete(actionInvocations).where(eq(actionInvocations.invocationId, request.invocationId));
      expect(await invoke(request, context)).toEqual({ ok: true, result: { value: "original" } });
      expect(execute).toHaveBeenCalledOnce();

      await pg.appDb.delete(actionInvocations).where(eq(actionInvocations.invocationId, request.invocationId));
      await pg.appDb.update(authorizationExecutionAttempts).set({ outcome: "completed", redactedResult: { ok: true, result: { value: "x".repeat(70_000) } }, redactedError: null, finishedAt: 30 });
      await expect(invoke(request, context)).resolves.toMatchObject({ ok: true, result: { truncated: true } });
      expect(execute).toHaveBeenCalledOnce();

      await pg.appDb.delete(actionInvocations).where(eq(actionInvocations.invocationId, request.invocationId));
      await pg.appDb.update(authorizationExecutionAttempts).set({ outcome: "started", redactedResult: null, redactedError: null, finishedAt: null });
      await expect(invoke(request, context)).resolves.toEqual({ ok: false, error: "indeterminate_execution: the action may have run. Do not retry automatically." });
      expect((await pg.appDb.select().from(authorizationExecutionAttempts))[0]?.outcome).toBe("indeterminate");
      expect(execute).toHaveBeenCalledOnce();
    } finally { await manager.close(); }
  }, 120_000);

  it("authorizes a resolved dynamic action before dispatch", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const execute = vi.fn(async () => ({ success: true, data: { ok: true } }));
    const actionPlugin: ActionPlugin = {
      service: "deepwiki",
      actions: [],
      safeParameterProjection: { schemaVersion: 1, mode: "all_safe" },
      resolveActions: async () => [{ id: "deepwiki.ask_question", name: "Ask", description: "Ask", riskLevel: "medium", parameters: Type.Object({ title: Type.String() }), execute }],
    };
    const plugin = { name: "deepwiki", version: "1", actions: [actionPlugin] } as ValetPlugin;
    const plugins = new Map([["deepwiki", { plugin, actionPlugin }]]);
    const manager = new CanonicalPolicyBundleManager(pg.appDb, plugins, () => 10);
    try {
      await manager.ensureOrganizationReady("org-1"); const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const authorize = vi.spyOn(service, "authorize");
      const invoke = buildActionInvoker({ db: pg.appDb, credentials, actionPluginByService: plugins, canonicalAuthorizationService: service, clock: () => 30 });
      const result = await invoke({ service: "deepwiki", action: "ask_question", params: { title: "One" }, invocationId: "workflow:run-1:dynamic" }, { userId: "user-1", orgId: "org-1", owner: { type: "user", id: "user-1" }, workflowExecutionId: "run-1", workflowDefinitionId: "workflow-1", workflowVersion: "1", workflowNodeId: "dynamic" });
      expect(result).toEqual({ ok: true, result: { ok: true } });
      expect(authorize).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
    } finally { await manager.close(); }
  }, 120_000);

  it("does not dispatch when decision audit reservation fails", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const execute = vi.fn(async () => ({ success: true })); const plugins = catalog(execute);
    const manager = new CanonicalPolicyBundleManager(pg.appDb, plugins, () => 10);
    try {
      await manager.ensureOrganizationReady("org-1"); const service = await CanonicalAuthorizationService.create(manager, () => 20);
      service.authorize = async () => { throw new Error("decision reservation failed"); };
      const invoke = buildActionInvoker({ db: pg.appDb, credentials, actionPluginByService: plugins, canonicalAuthorizationService: service, clock: () => 30 });
      await expect(invoke({ service: "github", action: "create_issue", params: { title: "Blocked" }, invocationId: "workflow:run-1:audit-failure" }, { userId: "user-1", orgId: "org-1", owner: { type: "user", id: "user-1" }, workflowExecutionId: "run-1", workflowDefinitionId: "workflow-1", workflowVersion: "1", workflowNodeId: "audit-failure" })).rejects.toThrow("decision reservation failed");
      expect(execute).not.toHaveBeenCalled();
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(0);
    } finally { await manager.close(); }
  }, 120_000);

  it("keeps credential secrets out of policy input, bundles, audit, and results", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const canary = "CANONICAL-SECRET-CANARY".repeat(8_192);
    const secretCredentials: CredentialStore = {
      get: async () => ({ type: "api_key", apiKey: canary }), save: async () => {}, delete: async () => {}, list: async () => [],
    };
    const execute = vi.fn(async (_args, context) => {
      expect((await context.credentials.get())?.accessToken).toBe(canary);
      return { success: true, data: { credentialResolved: true } };
    });
    const plugins = catalog(execute, "gmail", "gmail.send_email"); const manager = new CanonicalPolicyBundleManager(pg.appDb, plugins, () => 10);
    try {
      await manager.ensureOrganizationReady("org-1"); const service = await CanonicalAuthorizationService.create(manager, () => 20);
      let policyInput = ""; const authorize = service.authorize.bind(service);
      service.authorize = async (request) => { policyInput = JSON.stringify(request); return authorize(request); };
      const invoke = buildActionInvoker({ db: pg.appDb, credentials: secretCredentials, actionPluginByService: plugins, canonicalAuthorizationService: service, clock: () => 30 });
      const result = await invoke({ service: "gmail", action: "send_email", params: { title: "Safe" }, invocationId: "workflow:run-1:secret" }, { userId: "user-1", orgId: "org-1", owner: { type: "user", id: "user-1" }, workflowExecutionId: "run-1", workflowDefinitionId: "workflow-1", workflowVersion: "version-1", workflowNodeId: "secret" });
      expect(result).toEqual({ ok: true, result: { credentialResolved: true } });
      const persisted = JSON.stringify({
        bundles: await pg.appDb.select().from(policySourceBundles),
        decisions: await pg.appDb.select().from(authorizationDecisions),
        attempts: await pg.appDb.select().from(authorizationExecutionAttempts),
        invocations: await pg.appDb.select().from(actionInvocations),
      });
      expect(policyInput).not.toContain(canary);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(persisted).not.toContain(canary);
      const decisions = await pg.appDb.select().from(authorizationDecisions);
      const attempts = await pg.appDb.select().from(authorizationExecutionAttempts);
      expect(decisions.some((row) => row.requestId.startsWith("credential-use:"))).toBe(true);
      expect(attempts.some((row) => JSON.stringify(row.redactedResult) === '{"found":true,"authorized":true}' || JSON.stringify(row.redactedResult) === '{"authorized":true,"found":true}')).toBe(true);
    } finally { await manager.close(); }
  }, 120_000);
});
