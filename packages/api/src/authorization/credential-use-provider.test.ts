import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginCatalogTools, RESOLVE_TTL_MS, type CredentialProvider, type Sandbox, type ToolContext } from "@valet/engine";
import type { PolicyDecisionEnvelope } from "@valet/engine/authorization";
import { Type } from "typebox";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { orgs } from "../schema/index.js";
import { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { CanonicalPolicyBundleManager } from "./canonical-policy-manager.js";
import { CredentialUseDeniedError, withCredentialUseAuthorization } from "./credential-use-provider.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

function envelope(requestId: string, effect: "allow" | "deny" | "require_approval"): PolicyDecisionEnvelope {
  return {
    schemaVersion: 1, requestId, requestSubjectDigest: "a".repeat(64), inputDigest: "b".repeat(64),
    policyDigest: "c".repeat(64), sourceBundleDigest: "d".repeat(64),
    evaluator: { kind: "local_valet", engineDigest: "e".repeat(64) }, evaluatedAtMs: 1,
    decision: { effect, reasonCode: "test", matchedRuleIds: ["test.rule"], obligations: [], redactions: [], ...(effect === "require_approval" ? { approvalRequirement: { tier: "owner", approverType: "user" as const, replay: "once" as const } } : {}) },
  };
}

function binding() {
  return {
    organizationId: "org-1", actorUserId: "user-1", service: "gmail", credentialClass: "oauth2",
    principal: { type: "user" as const, id: "user-1" }, owner: { type: "user" as const, id: "user-1" },
    actionId: "gmail.send_email", operation: "workflow" as const, workflowExecutionId: "run-1", invocationId: "invocation-1",
  };
}

describe("credential use provider authorization", () => {
  it.each(["deny", "require_approval"] as const)("keeps the provider at spy zero for %s", async (effect) => {
    pg = await freshTestPgDb();
    const get = vi.fn(async () => ({ accessToken: "SECRET-CANARY" }));
    const inner: CredentialProvider = { get, request: async () => ({ accessToken: "SECRET-CANARY" }) };
    const authorize = vi.fn(async (request) => envelope(request.requestId, effect));
    const provider = withCredentialUseAuthorization(inner, { db: pg.appDb, authorization: { authorize }, binding: binding(), now: () => 1 });

    const error = await provider.get().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CredentialUseDeniedError);
    if (effect === "require_approval") expect(String(error)).toContain("require approval on the action instead");
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(authorize.mock.calls)).not.toContain("SECRET-CANARY");
  });

  it("reuses the real wrapper on cold and post-TTL dynamic catalog reads", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 1);
    try {
      await manager.ensureOrganizationReady("org-1");
      let now = 1, decisions = 0;
      const service = await CanonicalAuthorizationService.create(manager, () => now);
      const get = vi.fn(async () => ({ accessToken: "SECRET-CANARY" }));
      const inner: CredentialProvider = { get, request: async () => ({ accessToken: "SECRET-CANARY" }) };
      const authorization = { authorize: async (request: Parameters<typeof service.authorize>[0]) => { decisions++; return service.authorize(request); } };
      const plugin = { service: "notion", actions: [], requiresCredential: true, resolveActions: async ({ credentials }: { credentials: CredentialProvider }) => { await credentials.get(); return []; } };
      const [listTool] = pluginCatalogTools({ plugins: [plugin], clock: () => now });
      const ctx = (actionInvocationId: string): ToolContext => ({ userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", actionInvocationId, credentials: inner, sandbox: { id: "sandbox-1" } as Sandbox, signal: new AbortController().signal, requestDecision: async () => { throw new Error("unused"); }, threadRead: async () => [], listThreads: async () => [], setModel: async ({ model }) => ({ fromModel: model, toModel: model }), credentialProviderForAction: (provider, trusted) => withCredentialUseAuthorization(provider, { db: pg!.appDb, authorization, binding: trusted, now: () => now }) });
      await listTool.execute({}, ctx("list-1")); await listTool.execute({}, ctx("list-2"));
      now += RESOLVE_TTL_MS + 1; await listTool.execute({}, ctx("list-3"));
      expect({ reads: get.mock.calls.length, decisions }).toEqual({ reads: 3, decisions: 3 });
    } finally { await manager.close(); }
  }, 120_000);
});
