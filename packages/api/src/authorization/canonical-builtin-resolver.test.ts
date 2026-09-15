import { afterEach, describe, expect, it } from "vitest";
import { builtinAuthorization, type BuiltinPolicyResolveInput } from "@valet/engine";
import { authorizationDecisions, authorizationExecutionAttempts, orgs } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalBuiltinPolicyResolver } from "./canonical-builtin-resolver.js";
import { CanonicalPolicyBundleManager } from "./canonical-policy-manager.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });

function input(name = "read", overrides: Partial<BuiltinPolicyResolveInput> = {}): BuiltinPolicyResolveInput {
  return {
    descriptor: builtinAuthorization(name),
    args: name === "read" ? { path: "README.md", content: "SECRET_CANARY" } : {},
    userId: "user-1",
    orgId: "org-1",
    sessionId: "session-1",
    threadId: "thread-1",
    owner: { type: "user", id: "user-1" },
    queueItemId: "queue-1",
    toolCallId: "call-1",
    gateOrdinal: 0,
    ...overrides,
  };
}

describe("canonicalBuiltinPolicyResolver", () => {
  it("uses durable decisions and stores no content-bearing completed output", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const restart = () => canonicalBuiltinPolicyResolver({ db: pg!.appDb, service, clock: () => 30 });
      const request = input();
      const decision = await restart().resolve(request);
      expect(decision.mode).toBe("allow");
      const reservation = await restart().reserveExecution!(request, decision);
      expect(reservation.kind).toBe("execute");
      if (reservation.kind !== "execute") throw new Error("expected reservation");
      const secret = "SECRET_CANARY".repeat(20_000);
      await restart().completeExecution!(request, decision, reservation.attemptId, { outcome: "completed", result: { text: secret } });
      const replay = await restart().reserveExecution!(request, decision);
      expect(replay).toEqual({ kind: "completed", result: { text: "Tool completed previously, but its content-bearing output is unavailable.", code: "completed_output_unavailable", ok: false } });
      const persisted = JSON.stringify({ decisions: await pg.appDb.select().from(authorizationDecisions), attempts: await pg.appDb.select().from(authorizationExecutionAttempts) });
      expect(persisted).not.toContain("SECRET_CANARY");
      expect((await pg.appDb.select().from(authorizationExecutionAttempts))[0]?.redactedResult).toEqual({ text: "", code: "completed_output_unavailable", ok: false });
    } finally { await manager.close(); }
  }, 120_000);

  it("rejects changed safe input and preserves failed and indeterminate replay", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const restart = () => canonicalBuiltinPolicyResolver({ db: pg!.appDb, service, clock: () => 30 });
      const request = input();
      const decision = await restart().resolve(request);
      await expect(restart().reserveExecution!({ ...request, args: { path: "other" } }, decision)).rejects.toThrow("decision identity is invalid");
      const reservation = await restart().reserveExecution!(request, decision);
      expect((await restart().reserveExecution!(request, decision)).kind).toBe("indeterminate");
      if (reservation.kind !== "execute") throw new Error("expected reservation");
      await restart().completeExecution!(request, decision, reservation.attemptId, { outcome: "failed", error: "bounded failure" });
      expect(await restart().reserveExecution!(request, decision)).toEqual({ kind: "failed", error: "bounded failure" });
    } finally { await manager.close(); }
  }, 120_000);

  it("persists one-shot approval and arbitrates concurrent dispatch", async () => {
    pg = await freshTestPgDb();
    await pg.appDb.insert(orgs).values({ id: "org-1", name: "Org", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(pg.appDb, new Map(), () => 10);
    try {
      await manager.ensureOrganizationReady("org-1");
      const service = await CanonicalAuthorizationService.create(manager, () => 20);
      const resolver = canonicalBuiltinPolicyResolver({ db: pg.appDb, service, clock: () => 30 });
      const request = input("bash", { args: { command: "SECRET_COMMAND", timeout: 5 } });
      const gated = await resolver.resolve(request);
      expect(gated.mode).toBe("require_approval");
      await resolver.onResolution!(request, gated, { actionId: "approve", resolvedBy: "approver-1", resolvedAt: 25, gateOrdinal: 0 });
      const allowed = await resolver.resolve({ ...request, toolCallId: "call-after-restart" });
      expect(allowed.mode).toBe("allow");
      expect((await resolver.resolve({ ...request, toolCallId: "call-retry" })).canonical?.decisionId).toBe(allowed.canonical?.decisionId);
      expect((await resolver.resolve({ ...request, args: { command: "changed", timeout: 6 }, toolCallId: "call-changed" })).mode).toBe("require_approval");
      const reservations = await Promise.all([
        resolver.reserveExecution!({ ...request, toolCallId: "new-a" }, allowed),
        resolver.reserveExecution!({ ...request, toolCallId: "new-b" }, allowed),
      ]);
      expect(reservations.filter((item) => item.kind === "execute")).toHaveLength(1);
      expect(reservations.filter((item) => item.kind === "indeterminate")).toHaveLength(1);
      expect(JSON.stringify(await pg.appDb.select().from(authorizationDecisions))).not.toContain("SECRET_COMMAND");
    } finally { await manager.close(); }
  }, 120_000);
});
