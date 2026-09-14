import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginCatalogTools, type ActionPlugin, type CredentialProvider, type PolicyResolveInput, type Sandbox, type ToolContext, type ValetPlugin } from "@valet/engine";
import {
  actionInvocations,
  actionPolicies,
  authorizationDecisions,
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
  return { service: "github", actionId: riskLevel === "critical" ? "github.merge_pull_request" : "github.create_issue", riskLevel, parameterProjection: { schemaVersion: 1, mode: "all_safe" }, params: { value: "x" }, userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", appliesIn: "session", owner: { type: "user", id: "user-1" }, queueItemId: "queue-1", resumeKey: "call-1", gateOrdinal: 0 };
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
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(0);
      expect((await resolver.reserveExecution!(input("critical"), allowed)).kind).toBe("execute");
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(1);
    } finally { await manager.close(); }
  }, 120_000);

  it("replays durable results and stops concurrent duplicate dispatch", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    let releaseDispatch: (() => void) | undefined;
    const dispatchBlocked = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const credentialGet = vi.fn(async () => null);
    const execute = vi.fn(async (args: unknown, context: { credentials: CredentialProvider }) => {
      if (!args || typeof args !== "object" || !("value" in args) || typeof args.value !== "string") throw new Error("invalid test input");
      expect(await pg!.appDb.select().from(authorizationDecisions)).not.toHaveLength(0);
      expect((await pg!.appDb.select().from(authorizationExecutionAttempts)).some((row) => row.outcome === "started")).toBe(true);
      await context.credentials.get();
      if (args.value === "concurrent") await dispatchBlocked;
      if (args.value === "failure") throw new Error("provider failure");
      return { success: true, data: { value: args.value } };
    });
    const actionPlugin: ActionPlugin = { service: "github", safeParameterProjection: { schemaVersion: 1, mode: "all_safe" }, actions: [{ id: "github.create_issue", name: "Action", description: "Action", riskLevel: "low", parameters: Type.Object({ value: Type.String() }), execute }] };
    const plugin = { name: "github", version: "1", actions: [actionPlugin] } as ValetPlugin;
    const map = new Map([["github", { plugin, actionPlugin }]]); const manager = new CanonicalPolicyBundleManager(pg.appDb, map, () => 10);
    const credentials: CredentialProvider = { get: credentialGet, request: async () => { throw new Error("not connected"); } };
    const context = (resolver: ReturnType<typeof canonicalInteractivePolicyResolver>, queueItemId: string): ToolContext => ({
      userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" }, queueItemId,
      credentials, sandbox: { id: "sandbox-1" } as Sandbox, policyResolver: resolver, signal: new AbortController().signal,
      requestDecision: async () => { throw new Error("unexpected approval"); }, threadRead: async () => [], listThreads: async () => [], setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
    });
    try {
      await manager.ensureOrganizationReady("org-1"); const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const resolver = () => canonicalInteractivePolicyResolver({ db: pg!.appDb, service, plugins: map, clock: () => 30 });
      const call = pluginCatalogTools({ plugins: [actionPlugin] })[1]!;
      const first = await call.execute({ tool_id: "github.create_issue", params: { value: "done" }, summary: "create" }, context(resolver(), "queue-done"));
      expect(first.text).toContain("done");
      const credentialsAfterFirst = credentialGet.mock.calls.length;
      const replay = await call.execute({ tool_id: "github.create_issue", params: { value: "done" }, summary: "create" }, context(resolver(), "queue-done"));
      expect(replay).toEqual(first); expect(execute).toHaveBeenCalledTimes(1); expect(credentialGet).toHaveBeenCalledTimes(credentialsAfterFirst);

      const running = call.execute({ tool_id: "github.create_issue", params: { value: "concurrent" }, summary: "create" }, context(resolver(), "queue-concurrent"));
      while (execute.mock.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
      const duplicate = await call.execute({ tool_id: "github.create_issue", params: { value: "concurrent" }, summary: "create" }, context(resolver(), "queue-concurrent"));
      expect(duplicate.text).toContain("indeterminate_execution: the action may have run. Do not retry automatically.");
      expect(execute).toHaveBeenCalledTimes(2); releaseDispatch!(); await expect(running).resolves.toMatchObject({ ok: true });

      for (const [value, queueItemId] of [["success-crash", "queue-success-crash"], ["failure", "queue-failure-crash"]] as const) {
        const durable = resolver();
        const crashBeforePersistence = { ...durable, completeExecution: async () => { throw new Error("process stopped before outcome persistence"); } };
        const before = execute.mock.calls.length;
        const crashed = await call.execute({ tool_id: "github.create_issue", params: { value }, summary: "create" }, context(crashBeforePersistence, queueItemId));
        expect(crashed.text).toBe("indeterminate_execution: the action may have run. Do not retry automatically.");
        const redelivery = await call.execute({ tool_id: "github.create_issue", params: { value }, summary: "create" }, context(resolver(), queueItemId));
        expect(redelivery.text).toBe("indeterminate_execution: the action may have run. Do not retry automatically.");
        expect(execute).toHaveBeenCalledTimes(before + 1);
      }
      expect((await pg.appDb.select().from(authorizationExecutionAttempts)).map((row) => row.outcome).sort()).toEqual(["completed", "completed", "started", "started"]);
    } finally { releaseDispatch?.(); await manager.close(); }
  }, 120_000);

  it("keeps live results full and replays bounded audit-safe results", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const payload = "x".repeat(20_000);
    const credentialGet = vi.fn(async () => null);
    const execute = vi.fn(async (args: unknown, context: { credentials: CredentialProvider }) => {
      if (!args || typeof args !== "object" || !("value" in args) || typeof args.value !== "string") throw new Error("invalid test input");
      await context.credentials.get();
      return args.value === "success"
        ? { success: true, data: payload }
        : { success: false, error: payload };
    });
    const actionPlugin: ActionPlugin = { service: "github", safeParameterProjection: { schemaVersion: 1, mode: "all_safe" }, actions: [{ id: "github.create_issue", name: "Action", description: "Action", riskLevel: "low", parameters: Type.Object({ value: Type.String() }), execute }] };
    const plugin = { name: "github", version: "1", actions: [actionPlugin] } as ValetPlugin;
    const map = new Map([["github", { plugin, actionPlugin }]]);
    const manager = new CanonicalPolicyBundleManager(pg.appDb, map, () => 10);
    const credentials: CredentialProvider = { get: credentialGet, request: async () => { throw new Error("not connected"); } };
    const context = (resolver: ReturnType<typeof canonicalInteractivePolicyResolver>, queueItemId: string): ToolContext => ({
      userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" }, queueItemId,
      credentials, sandbox: { id: "sandbox-1" } as Sandbox, policyResolver: resolver, signal: new AbortController().signal,
      requestDecision: async () => { throw new Error("unexpected approval"); }, threadRead: async () => [], listThreads: async () => [], setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
    });
    const waitForActionLog = async (count: number) => {
      for (let i = 0; i < 100; i += 1) {
        const rows = await pg!.appDb.select().from(actionInvocations);
        if (rows.length === count) return rows;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`Action Log did not contain ${count} rows.`);
    };
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const restart = () => canonicalInteractivePolicyResolver({ db: pg!.appDb, service, plugins: map, clock: () => 30 });
      const call = pluginCatalogTools({ plugins: [actionPlugin] })[1]!;

      const first = await call.execute({ tool_id: "github.create_issue", params: { value: "success" }, summary: "create" }, context(restart(), "queue-success"));
      expect(first.text).toBe(payload);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(credentialGet).toHaveBeenCalledTimes(1);
      expect((await pg.appDb.select().from(authorizationExecutionAttempts))[0]?.redactedResult).toMatchObject({ success: true, data: { truncated: true } });
      expect(await waitForActionLog(1)).toMatchObject([{ status: "completed", result: { truncated: true } }]);

      const replay = await call.execute({ tool_id: "github.create_issue", params: { value: "success" }, summary: "create" }, context(restart(), "queue-success"));
      expect(replay.text).toContain("replay result truncated");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(credentialGet).toHaveBeenCalledTimes(1);
      expect(await waitForActionLog(1)).toHaveLength(1);

      const auditCrash = { ...restart(), onInvocation: async () => { throw new Error("process stopped after settlement"); } };
      const crashed = await call.execute({ tool_id: "github.create_issue", params: { value: "failure" }, summary: "create" }, context(auditCrash, "queue-failure"));
      expect(crashed.text).toBe(`github.create_issue failed: ${payload}`);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(credentialGet).toHaveBeenCalledTimes(2);
      expect((await pg.appDb.select().from(authorizationExecutionAttempts))[1]?.redactedResult).toMatchObject({ success: false, data: { truncated: true } });
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(await pg.appDb.select().from(actionInvocations)).toHaveLength(1);

      const repaired = await call.execute({ tool_id: "github.create_issue", params: { value: "failure" }, summary: "create" }, context(restart(), "queue-failure"));
      expect(repaired.text).toContain("replay result truncated");
      expect(repaired.text.length).toBeLessThan(payload.length);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(credentialGet).toHaveBeenCalledTimes(2);
      expect(await waitForActionLog(2)).toMatchObject([
        { status: "completed", result: { truncated: true } },
        { status: "completed", result: { truncated: true } },
      ]);

      await call.execute({ tool_id: "github.create_issue", params: { value: "failure" }, summary: "create" }, context(restart(), "queue-failure"));
      expect(execute).toHaveBeenCalledTimes(2);
      expect(credentialGet).toHaveBeenCalledTimes(2);
      expect(await waitForActionLog(2)).toHaveLength(2);
    } finally {
      await manager.close();
    }
  }, 120_000);

  it("survives crashes at every interactive execution boundary", async () => {
    pg = await freshTestPgDb(); await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const map = plugins("low"); const manager = new CanonicalPolicyBundleManager(pg.appDb, map, () => 10);
    try {
      await manager.ensureOrganizationReady("org-1"); const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const restart = () => canonicalInteractivePolicyResolver({ db: pg!.appDb, service, plugins: map, clock: () => 30 });
      const resolver = restart(); const decision = await resolver.resolve(input("low"));
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(0);
      await expect(resolver.reserveExecution!({ ...input("low"), params: { value: "changed" } }, decision)).rejects.toThrow("decision identity is invalid");
      const reservation = await resolver.reserveExecution!(input("low"), decision); expect(reservation.kind).toBe("execute");
      expect((await restart().reserveExecution!(input("low"), decision)).kind).toBe("indeterminate");
      if (reservation.kind !== "execute") throw new Error("expected execution reservation");
      await expect(resolver.completeExecution!({ ...input("low"), params: { value: "changed" } }, decision, reservation.attemptId, { outcome: "completed", result: { success: true } })).rejects.toThrow("decision identity is invalid");
      const persisted = await resolver.completeExecution!(input("low"), decision, reservation.attemptId, { outcome: "completed", result: { success: true, data: { text: "x".repeat(20_000) } } });
      expect(JSON.stringify(persisted).length).toBeLessThan(9_000);
      if (persisted.outcome !== "completed") throw new Error("expected completed settlement");
      expect(await restart().reserveExecution!(input("low"), decision)).toEqual({ kind: "completed", result: persisted.result });

      const failedInput = { ...input("low"), queueItemId: "queue-failed", resumeKey: "call-failed" };
      const failedDecision = await restart().resolve(failedInput); const failedReservation = await restart().reserveExecution!(failedInput, failedDecision);
      if (failedReservation.kind !== "execute") throw new Error("expected failure reservation");
      await restart().completeExecution!(failedInput, failedDecision, failedReservation.attemptId, { outcome: "failed", error: "redacted failure" });
      expect(await restart().reserveExecution!(failedInput, failedDecision)).toEqual({ kind: "failed", error: "redacted failure" });
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
