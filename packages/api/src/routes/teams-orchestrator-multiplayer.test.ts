/** Shared team executions admit both members and recheck membership on access. */
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { teamMembers, teams } from "../schema/index.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import type { WireEvent } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** One team with two real members: the fixed stub identity and a second
 * seeded one. `x-valet-test-user-id` swaps which of them is acting. */
async function seedTeamWithTwoMembers(target: TestApi): Promise<string> {
  const now = Date.now();
  await target.providers.db
    .insert(teams)
    .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
  await target.providers.db.insert(teamMembers).values([
    { teamId: "team_1", userId: "local-user", role: "admin" },
    { teamId: "team_1", userId: "test-member", role: "member" },
  ]);
  const shared = await ensureAssistantExecution(target.providers, { type: "team", id: "team_1" },
    { orgId: "local-org", actorUserId: "local-user" }, "web:default");
  return shared.sessionId;
}

interface Socket {
  ws: WebSocket;
  frames: WireEvent[];
  closes: { code: number }[];
}

function openSocket(wsUrl: string, sessionId: string, userId: string): Socket {
  const frames: WireEvent[] = [];
  const closes: { code: number }[] = [];
  const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws`, {
    headers: { "x-valet-test-user-id": userId },
  });
  ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as WireEvent));
  ws.on("close", (code) => closes.push({ code }));
  return { ws, frames, closes };
}

/** Sockets and queue frames are asynchronous; poll rather than sleeping a
 * fixed span, so the case is not tuned to one machine's timing. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe("team orchestrator — two members at once", () => {
  it("accepts a socket from each member and greets both", async () => {
    api = await bootTestApi();
    const sessionId = await seedTeamWithTwoMembers(api);

    const a = openSocket(api.wsUrl, sessionId, "local-user");
    const b = openSocket(api.wsUrl, sessionId, "test-member");

    const ready = await until(
      () => a.frames.some((f) => f.type === "init") && b.frames.some((f) => f.type === "init"),
    );
    a.ws.close();
    b.ws.close();

    expect(ready).toBe(true);
    expect(a.closes).toHaveLength(0);
    expect(b.closes).toHaveLength(0);
  });

  it("broadcasts one member's turn to the other member's socket", async () => {
    api = await bootTestApi();
    const sessionId = await seedTeamWithTwoMembers(api);

    const a = openSocket(api.wsUrl, sessionId, "local-user");
    const b = openSocket(api.wsUrl, sessionId, "test-member");
    await until(
      () => a.frames.some((f) => f.type === "init") && b.frames.some((f) => f.type === "init"),
    );

    // A prompts. B touched nothing.
    await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello from A" }),
    });

    const reached = await until(() => b.frames.some((f) => f.type === "queue.state"));
    a.ws.close();
    b.ws.close();

    expect(reached).toBe(true);
  });
});

describe("team orchestrator — access is the team's, not the opener's", () => {
  it("gives both members the same answer, so neither is privileged", async () => {
    api = await bootTestApi();
    const sessionId = await seedTeamWithTwoMembers(api);
    const enc = encodeURIComponent(sessionId);

    const asOpener = await fetch(`${api.baseUrl}/api/sessions/${enc}/messages`);
    const asOther = await fetch(`${api.baseUrl}/api/sessions/${enc}/messages`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });

    expect(asOpener.status).toBe(200);
    // The member who did NOT create the session must not be second-class:
    // `ensureDefaultAssistantSession` stamps `agent_sessions.userId` with whoever
    // opened it first, and reading that stamp as ownership is the exact bug
    // `canViewSession` exists to avoid.
    expect(asOther.status).toBe(asOpener.status);
    expect(await asOther.json()).toEqual(await asOpener.json());
  });

  it("takes access away as soon as membership ends", async () => {
    api = await bootTestApi();
    const sessionId = await seedTeamWithTwoMembers(api);
    const enc = encodeURIComponent(sessionId);

    const before = await fetch(`${api.baseUrl}/api/sessions/${enc}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(before.status).toBe(200);

    await api.providers.db
      .delete(teamMembers)
      .where(eq(teamMembers.userId, "test-member"));

    // Re-read, not cached: membership is checked at request time, so removal
    // takes effect on the next call rather than at the next login.
    const after = await fetch(`${api.baseUrl}/api/sessions/${enc}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(after.status).toBe(404);
  });
});
