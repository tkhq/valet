import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, authorizationDecisions, authorizationExecutionAttempts } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const create = (key: string) => fetch(`${api!.baseUrl}/api/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": key },
  body: JSON.stringify({ workspace: "/tmp" }),
});

describe("route execution reservation", () => {
  it("replays a completed mutation without invoking its handler again", async () => {
    api = await bootTestApi();
    const first = await create("route-mutation-1");
    expect(first.status).toBe(201);
    const second = await create("route-mutation-1");
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ code: "authorization_completed_replay", originalStatus: 201 });
    expect(await api.providers.db.select().from(agentSessions)).toHaveLength(1);
    const attempts = await api.providers.db.select().from(authorizationExecutionAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "completed", targetIdempotencyKey: "route-mutation-1", redactedResult: { status: 201 } });
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
