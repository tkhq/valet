/**
 * "Run without asking" (`services/thread-approval-bypass.ts`): who may turn
 * it on for a thread, and how the thread reports it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mintCliToken } from "../auth/cli-tokens.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, sessionThreads, teamMembers, teams, users } from "../schema/index.js";
import type { ListThreadsResponse, ThreadSummary } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const MEMBER = "test-member";
const as = (user: string) => ({ "x-valet-test-user-id": user, "content-type": "application/json" });

async function boot(): Promise<{ api: TestApi; thread: { id: string; sessionId: string } }> {
  const booted = await bootTestApi();
  api = booted;
  const response = await fetch(`${booted.baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(201);
  return { api: booted, thread: await response.json() as { id: string; sessionId: string } };
}

function setBypass(target: TestApi, threadId: string, on: unknown, headers: Record<string, string> = as("local-user")) {
  return fetch(`${target.baseUrl}/api/threads/${threadId}`, { method: "PATCH", headers, body: JSON.stringify({ approvalBypass: on }) });
}

describe("run without asking", () => {
  it("lets the owner of a personal thread turn it on and off, and lists it on the thread", async () => {
    const { api, thread } = await boot();
    const on = await setBypass(api, thread.id, true);
    expect(on.status).toBe(200);
    expect(((await on.json()) as ThreadSummary).approvalBypass).toBe(true);
    const [row] = await api.providers.db.select().from(sessionThreads).where(eq(sessionThreads.id, thread.id));
    expect(row?.approvalBypassBy).toBe("local-user");
    const list = (await (await fetch(`${api.baseUrl}/api/threads`)).json()) as ListThreadsResponse;
    expect(list.threads.find((t) => t.id === thread.id)?.approvalBypass).toBe(true);

    const off = await setBypass(api, thread.id, false);
    expect(off.status).toBe(200);
    expect(((await off.json()) as ThreadSummary).approvalBypass).toBeUndefined();
    expect((await setBypass(api, thread.id, "yes")).status).toBe(400);
  });

  it("refuses a key or an agent credential that holds the owner's identity", async () => {
    const booted = await bootTestApi({ auth: true });
    api = booted;
    const signup = await fetch(`${booted.baseUrl}/api/auth/sign-up/email`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Person", email: "bypass-owner@example.test", password: "correct-horse-battery" }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error("Missing browser session cookie");
    const [person] = await booted.providers.db.select().from(users).where(eq(users.email, "bypass-owner@example.test"));
    if (!person) throw new Error("Missing signed-in person");
    const browser = { cookie, "content-type": "application/json" };
    const created = await fetch(`${booted.baseUrl}/api/threads`, { method: "POST", headers: browser, body: "{}" });
    expect(created.status).toBe(201);
    const thread = await created.json() as { id: string };
    const created2 = await fetch(`${booted.baseUrl}/api/auth/api-key/create`, { method: "POST", headers: browser, body: JSON.stringify({ name: "bypass-key" }) });
    expect(created2.status).toBe(200);
    const key = { "x-api-key": ((await created2.json()) as { key: string }).key, "content-type": "application/json" };
    const token = await mintCliToken(booted.providers.db, person.id, "agent");
    const agent = { "x-api-key": token.access_token, "content-type": "application/json" };

    // A plain API key reaches the route, which asks for the browser.
    const refused = await setBypass(booted, thread.id, true, key);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/signed in to your browser/);
    // An agent credential never changes thread settings at all.
    expect((await setBypass(booted, thread.id, true, agent)).status).toBe(403);
    expect((await setBypass(booted, thread.id, true, browser)).status).toBe(200);
    // Turning it off is never refused to a caller who may change the thread.
    expect((await setBypass(booted, thread.id, false, key)).status).toBe(200);
  });

  it("lets only a team admin turn it on for a team thread", async () => {
    const { api, thread } = await boot();
    const { db } = api.providers;
    await db.insert(teams).values({ id: "bypass-team", orgId: "local-org", name: "Ops", createdAt: Date.now() });
    await db.insert(teamMembers).values([
      { teamId: "bypass-team", userId: "local-user", role: "admin" },
      { teamId: "bypass-team", userId: MEMBER, role: "member" },
    ]);
    await db.update(agentSessions).set({ ownerType: "team", ownerId: "bypass-team" }).where(eq(agentSessions.id, thread.sessionId));
    api.providers.engineHost.evictCache(thread.sessionId);
    const path = `${api.baseUrl}/api/sessions/${encodeURIComponent(thread.sessionId)}/threads/${thread.id}`;
    const patch = (user: string, on: boolean) => fetch(path, { method: "PATCH", headers: as(user), body: JSON.stringify({ approvalBypass: on }) });

    const member = await patch(MEMBER, true);
    expect(member.status).toBe(403);
    expect(((await member.json()) as { error: string }).error).toMatch(/team admin/);
    expect((await patch("local-user", true)).status).toBe(200);
    // Any member who sees it on may turn it off.
    expect((await patch(MEMBER, false)).status).toBe(200);
  });
});
