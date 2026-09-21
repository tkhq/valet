import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionPolicies, agentSessions, authorizationDecisions, authorizationExecutionAttempts, orgMembers, users } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); await api?.cleanup(); api = undefined; });

describe("durable route approval HTTP flow", () => {
  it("resolves once, reauthorizes at the current time, and dispatches once", async () => {
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base);
    api = await bootTestApi();
    const created = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: "/tmp" }),
    });
    const sessionId = ((await created.json()) as { id: string }).id;
    const otherCreated = await fetch(`${api.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: "/tmp/other" }) });
    const otherSessionId = ((await otherCreated.json()) as { id: string }).id;
    await api.providers.db.insert(users).values([
      { id: "approval-admin", name: "Approval Admin", email: "approval-admin@test.invalid", role: "admin" },
      { id: "other-admin", name: "Other Admin", email: "other-admin@test.invalid", role: "admin" },
    ]);
    await api.providers.db.insert(orgMembers).values([
      { orgId: "local-org", userId: "approval-admin", role: "admin", createdAt: base },
      { orgId: "local-org", userId: "other-admin", role: "admin", createdAt: base },
    ]);
    await api.providers.canonicalAuthorizationService.mutateAndActivate("local-org", {
      actorId: "local-user", operation: "test_route_approval", idempotencyKey: "test-route-approval-policy",
    }, async (tx) => {
      await tx.insert(actionPolicies).values({
        id: "route-delete-approval", orgId: "local-org", authorizationKind: "api.route", principalType: "org", principalId: "local-org",
        actionId: "api_sessions.delete_sessions_item", mode: "require_approval", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: base, updatedAt: base,
      });
    });

    const beforeUnsupported = (await api.providers.db.select().from(authorizationDecisions)).length;
    for (const request of [
      fetch(`${api.baseUrl}/api/sessions/${sessionId}?force=A`, { method: "DELETE" }),
      fetch(`${api.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }),
    ]) {
      const response = await request; expect(response.status).toBe(422); await expect(response.json()).resolves.toMatchObject({ code: "approval_unsupported" });
    }
    expect(await api.providers.db.select().from(authorizationDecisions)).toHaveLength(beforeUnsupported);
    const first = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
    expect(first.status).toBe(409);
    const decisionId = ((await first.json()) as { decisionId: string }).decisionId;
    expect((await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0]?.status).toBe("active");
    const selfApproval = await fetch(`${api.baseUrl}/api/authorization/decisions/${decisionId}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, verdict: "approved" }),
    });
    expect(selfApproval.status).toBe(403);
    await expect(selfApproval.json()).resolves.toMatchObject({ code: "authorization_self_approval_denied" });

    vi.spyOn(Date, "now").mockRestore();
    vi.spyOn(Date, "now").mockImplementation(() => base + 60_000);
    const resolve = (actor: string, verdict: "approved" | "rejected") => fetch(`${api!.baseUrl}/api/authorization/decisions/${decisionId}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-valet-test-user-id": actor }, body: JSON.stringify({ schemaVersion: 1, verdict }),
    });
    const resolution = await resolve("approval-admin", "approved");
    expect(resolution.status).toBe(200);
    const resolutionId = ((await resolution.json()) as { resolutionId: string }).resolutionId;
    expect((await resolve("approval-admin", "approved")).status).toBe(200);
    const conflict = await resolve("other-admin", "rejected");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "authorization_resolution_conflict", existing: { resolutionId, verdict: "approved" } });

    vi.spyOn(Date, "now").mockRestore();
    vi.spyOn(Date, "now").mockImplementation(() => base + 120_000);
    const changedPath = await fetch(`${api.baseUrl}/api/sessions/${otherSessionId}`, { method: "DELETE", headers: { "Idempotency-Key": "changed-path", "X-Valet-Approval-Resolution": resolutionId } });
    expect(changedPath.status).toBe(409);
    await expect(changedPath.json()).resolves.toMatchObject({ code: "authorization_approval_conflict" });
    const changedQuery = await fetch(`${api.baseUrl}/api/sessions/${sessionId}?force=B`, { method: "DELETE", headers: { "Idempotency-Key": "changed-query", "X-Valet-Approval-Resolution": resolutionId } });
    expect(changedQuery.status).toBe(422);
    await expect(changedQuery.json()).resolves.toMatchObject({ code: "approval_unsupported" });

    const redeem = (key: string) => fetch(`${api!.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE", headers: { "Idempotency-Key": key, "X-Valet-Approval-Resolution": resolutionId } });
    const concurrent = await Promise.all([redeem("K1"), redeem("K2")]);
    expect(concurrent.some((response) => response.status === 200)).toBe(true);
    expect(concurrent.every((response) => response.status === 200 || response.status === 409)).toBe(true);
    expect((await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0]?.status).toBe("deleted");
    expect((await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, otherSessionId)))[0]?.status).toBe("active");
    const deleteAttempts = async () => (await api!.providers.db.select().from(authorizationExecutionAttempts)).filter((row) => row.targetIdempotencyKey?.startsWith("approval:"));
    expect(await deleteAttempts()).toHaveLength(1);

    const replay = await redeem("K3");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-valet-execution-replay")).toBe("true");
    expect(await replay.json()).resolves.toEqual({ code: "completed_output_unavailable" });
    expect(await deleteAttempts()).toHaveLength(1);
  }, 120_000);
});
