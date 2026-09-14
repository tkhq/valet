import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginCatalogTools, type ActionPlugin, type CredentialProvider, type PolicyDecision, type PolicyResolveInput, type Sandbox, type ToolContext, type ValetPlugin } from "@valet/engine";
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
      const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const restart = () => canonicalInteractivePolicyResolver({ db: pg!.appDb, service, plugins: map, clock: () => clock });
      const resolver = restart();
      const pending = await resolver.resolve(input("critical")); expect(pending.mode).toBe("require_approval");
      const replayedBeforeResolution = await restart().resolve(input("critical"));
      expect(replayedBeforeResolution.canonical).toEqual(pending.canonical);
      await expect(restart().onResolution!({ ...input("critical"), params: { value: "changed" } }, replayedBeforeResolution, { actionId: "approve", resolvedBy: "user-2", resolvedAt: 31, gateOrdinal: 1 })).rejects.toThrow("decision identity is invalid");
      const equivalentRetry = { ...input("critical"), queueItemId: "queue-2" };
      const retryPending = await restart().resolve(equivalentRetry);
      expect(retryPending.mode).toBe("require_approval");
      expect(retryPending.canonical?.decisionId).not.toBe(pending.canonical?.decisionId);
      await restart().onResolution!(input("critical"), replayedBeforeResolution, { actionId: "approve", resolvedBy: "user-2", resolvedAt: 31, gateOrdinal: 1 });
      await restart().onResolution!(input("critical"), replayedBeforeResolution, { actionId: "approve", resolvedBy: "user-2", resolvedAt: 31, gateOrdinal: 1 });
      clock = 32;
      const allowed = await restart().resolve(input("critical")); expect(allowed.mode).toBe("allow");
      expect(await pg.appDb.select().from(canonicalApprovalResolutions)).toHaveLength(1);
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(0);
      expect((await resolver.reserveExecution!(input("critical"), allowed)).kind).toBe("execute");
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(1);
      clock = 31 + 72 * 60 * 60 * 1000;
      expect((await restart().resolve(input("critical"))).mode).toBe("require_approval");
      expect(await pg.appDb.select().from(canonicalApprovalResolutions)).toHaveLength(1);
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
    ["approve_session", false, 1, 1, 0, 0],
    ["always_allow", false, 1, 0, 1, 1],
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

describe("canonical interactive restart lifecycle", () => {
  it("keeps the original approval identity across an engine and thread restart", async () => {
    const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import("@earendil-works/pi-ai/compat");
    const { Engine, InMemoryCredentialStore, InMemoryEventStream, VirtualSandboxProvider } = await import("@valet/engine");
    const { PgSessionStore } = await import("@valet/store-postgres");
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const execute = vi.fn(async () => ({ success: true, data: "executed" }));
    const actionPlugin: ActionPlugin = {
      service: "github",
      safeParameterProjection: { schemaVersion: 1, mode: "all_safe" },
      actions: [{ id: "github.merge_pull_request", name: "Merge", description: "Merge", riskLevel: "critical", parameters: Type.Object({ value: Type.String() }), execute }],
    };
    const plugin = { name: "github", version: "1", actions: [actionPlugin] } as ValetPlugin;
    const map = new Map([["github", { plugin, actionPlugin }]]);
    const manager = new CanonicalPolicyBundleManager(pg.appDb, map, () => 10);
    const store = new PgSessionStore(pg.pgdb);
    const sandboxProvider = new VirtualSandboxProvider();
    const credentials = new InMemoryCredentialStore();
    const optionsFor = (model: NonNullable<ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>>, resolver: ReturnType<typeof canonicalInteractivePolicyResolver>) => ({
      userId: "user-1", orgId: "org-1", workspace: "/", sandbox: {}, model,
      tools: pluginCatalogTools({ plugins: [actionPlugin] }), policyResolver: resolver, credentials,
    });
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const firstResolver = canonicalInteractivePolicyResolver({ db: pg.appDb, service, plugins: map, clock: () => 30 });
      const first = registerFauxProvider({ provider: "canonical-gate-before-restart" });
      first.setResponses([fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "github.merge_pull_request", params: { value: "x" }, summary: "merge" }, { id: "old-tool-call" })], { stopReason: "toolUse" })]);
      const firstBus = new InMemoryEventStream();
      const firstEngine = new Engine({ providers: { store, stream: firstBus, sandboxProvider } });
      const firstModel = first.getModel();
      if (!firstModel) throw new Error("missing first faux model");
      const session = await firstEngine.createSession({ id: "approval-restart", ...optionsFor(firstModel, firstResolver) });
      const gate = await new Promise<import("@valet/engine").DecisionGate>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("approval gate timeout")), 5_000);
        const unsubscribe = firstBus.subscribe({}, (event) => {
          if (event.event.type === "decision_gate") { clearTimeout(timeout); unsubscribe(); resolve(event.event.gate); }
        });
        void session.prompt("merge");
      });
      const original = (await pg.appDb.select().from(authorizationDecisions))[0]!;
      first.unregister();

      const restartedResolver = canonicalInteractivePolicyResolver({ db: pg.appDb, service, plugins: map, clock: () => 33 });
      const onResolution = restartedResolver.onResolution!.bind(restartedResolver);
      let replayedDecision: PolicyDecision | undefined;
      restartedResolver.onResolution = async (resolveInput, decision, resolution) => {
        replayedDecision = decision;
        await onResolution(resolveInput, decision, resolution);
      };
      const second = registerFauxProvider({ provider: "canonical-gate-after-restart" });
      second.setResponses([fauxAssistantMessage("done")]);
      const secondBus = new InMemoryEventStream();
      const secondEngine = new Engine({ providers: { store, stream: secondBus, sandboxProvider } });
      const secondModel = second.getModel();
      if (!secondModel) throw new Error("missing second faux model");
      const restored = await secondEngine.restoreSession({ sessionId: "approval-restart", options: optionsFor(secondModel, restartedResolver) });
      await restored.resolveDecision(gate.id, { actionId: "approve", resolvedBy: "user-1", resolvedAt: 32 });
      const suspended = await store.getSuspendedTurn("approval-restart", gate.threadId);
      const queueItemId = suspended?.queueItemId ?? gate.queueItemId;
      for (let attempt = 0; attempt < 1_000 && (await store.getQueueItem("approval-restart", queueItemId))?.status !== "settled"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));

      expect(replayedDecision?.canonical).toMatchObject({
        decisionId: original.decisionId,
        requestSubjectDigest: original.requestSubjectDigest,
        inputDigest: original.inputDigest,
        policyDigest: original.policyDigest,
        sourceBundleDigest: original.sourceBundleDigest,
        engineDigest: original.evaluatorEngineDigest,
        decisionDigest: original.evidence?.decisionDigest,
        profileDigest: original.evidence?.profileDigest,
        interpreterDigest: original.evidence?.interpreterDigest,
        contractDigest: original.evidence?.contractDigest,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(await pg.appDb.select().from(canonicalApprovalResolutions)).toHaveLength(1);
      expect(await pg.appDb.select().from(authorizationExecutionAttempts)).toHaveLength(1);
      second.unregister();
    } finally { await manager.close(); }
  }, 120_000);
});
