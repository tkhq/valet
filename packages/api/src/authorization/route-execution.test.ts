import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionPolicies, agentSessions, authorizationDecisions, authorizationExecutionAttempts } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const create = (key: string, workspace = "/tmp") => fetch(`${api!.baseUrl}/api/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": key },
  body: JSON.stringify({ workspace }),
});

describe("route execution reservation", () => {
  it("replays a completed mutation without invoking its handler again", async () => {
    api = await bootTestApi();
    const first = await create("route-mutation-1");
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const second = await create("route-mutation-1");
    expect(second.status).toBe(201);
    expect(second.headers.get("x-valet-execution-replay")).toBe("true");
    await expect(second.json()).resolves.toEqual(firstBody);
    expect(await api.providers.db.select().from(agentSessions)).toHaveLength(1);
    const attempts = await api.providers.db.select().from(authorizationExecutionAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "completed", targetIdempotencyKey: "route-mutation-1", redactedResult: { status: 201, outputAvailable: true } });
    expect(await api.providers.db.select().from(authorizationDecisions)).toHaveLength(2);
  });

  it("freshly authorizes a replay and rejects changed request semantics", async () => {
    api = await bootTestApi();
    expect((await create("route-mutation-semantics", "/tmp/one")).status).toBe(201);
    const replay = await create("route-mutation-semantics", "/tmp/two");
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: "authorization_idempotency_conflict" });
    expect(await api.providers.db.select().from(agentSessions)).toHaveLength(1);
    expect(await api.providers.db.select().from(authorizationDecisions)).toHaveLength(2);
  });

  it("blocks completed replay after a new route deny", async () => {
    api = await bootTestApi();
    expect((await create("route-mutation-new-deny")).status).toBe(201);
    const now = Date.now();
    await api.providers.canonicalAuthorizationService.mutateAndActivate("local-org", {
      actorId: "local-user", operation: "test_new_deny", idempotencyKey: "test-new-route-deny",
    }, async (tx) => {
      await tx.insert(actionPolicies).values({
        id: "deny-session-create-replay", orgId: "local-org", authorizationKind: "api.route", principalType: "org", principalId: "local-org",
        actionId: "api_sessions.post_sessions", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: now, updatedAt: now,
      });
    });
    const replay = await create("route-mutation-new-deny");
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({ code: "authorization_denied" });
    expect(await api.providers.db.select().from(agentSessions)).toHaveLength(1);
  });

  it("replays a handled error with its original status", async () => {
    api = await bootTestApi();
    const first = await create("route-mutation-error", "relative");
    expect(first.status).toBe(400);
    const body = await first.json();
    const replay = await create("route-mutation-error", "relative");
    expect(replay.status).toBe(400);
    expect(replay.headers.get("x-valet-execution-replay")).toBe("true");
    await expect(replay.json()).resolves.toEqual(body);
    expect((await api.providers.db.select().from(authorizationExecutionAttempts))[0]).toMatchObject({ outcome: "failed", redactedResult: { status: 400 } });
  });

  it("ignores a read idempotency key after a new route deny", async () => {
    api = await bootTestApi();
    const headers = { "Idempotency-Key": "read-key-cannot-pin" };
    expect((await fetch(`${api.baseUrl}/api/sessions`, { headers })).status).toBe(200);
    const now = Date.now();
    await api.providers.canonicalAuthorizationService.mutateAndActivate("local-org", {
      actorId: "local-user", operation: "test_read_deny", idempotencyKey: "test-new-read-deny",
    }, async (tx) => {
      await tx.insert(actionPolicies).values({
        id: "deny-session-read-replay", orgId: "local-org", authorizationKind: "api.route", principalType: "org", principalId: "local-org",
        actionId: "api_sessions.get_sessions", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: now, updatedAt: now,
      });
    });
    const denied = await fetch(`${api.baseUrl}/api/sessions`, { headers });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: "authorization_denied" });
  });

  it("returns an indeterminate replay and never reserves reads", async () => {
    api = await bootTestApi();
    expect((await create("route-mutation-2")).status).toBe(201);
    await api.providers.db.update(authorizationExecutionAttempts).set({ outcome: "indeterminate", redactedResult: null });
    const replay = await create("route-mutation-2");
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: "authorization_indeterminate" });
    expect(await api.providers.db.select().from(agentSessions)).toHaveLength(1);

    const before = (await api.providers.db.select().from(authorizationDecisions)).length;
    expect((await fetch(`${api.baseUrl}/api/sessions`)).status).toBe(200);
    expect((await fetch(`${api.baseUrl}/api/sessions`)).status).toBe(200);
    const after = (await api.providers.db.select().from(authorizationDecisions)).length;
    expect(after - before).toBe(2);
    expect(await api.providers.db.select().from(authorizationExecutionAttempts)).toHaveLength(1);
  });
});
