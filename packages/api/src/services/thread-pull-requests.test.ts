import { eq } from "drizzle-orm";
import { agentSessions, childWatches, orgs, threadPullRequests } from "../schema/index.js";
import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { recordDelegatedPullRequest, recordThreadPullRequest, recheckOpenPullRequests, PULL_REQUEST_RECHECK_MS, setPullRequestState, startPullRequestSweep } from "./thread-pull-requests.js";
import { listThreadActivity } from "./thread-read-state.js";

let api: TestApi | undefined;
afterEach(async () => { vi.useRealTimers(); await api?.cleanup(); api = undefined; });

it("claims one provider check across parallel workers and duplicate thread associations", async () => {
  api = await bootTestApi();
  const thread = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { id: string; sessionId: string };
  const now = Date.now();
  const url = "https://github.com/acme/app/pull/7";
  for (const threadId of [thread.id, "ancestor"]) await recordThreadPullRequest(api.providers.db, { sessionId: thread.sessionId, threadId, url }, now - PULL_REQUEST_RECHECK_MS - 1);
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", { type: "oauth2", accessToken: "org-token" });
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer org-token");
    return Response.json({ html_url: url, state: "closed", merged: true });
  });
  const deps = { db: api.providers.db, credentials: api.providers.engineCredentials, key: Buffer.alloc(32), env: {}, fetchImpl };
  await Promise.all([recheckOpenPullRequests(deps, api.providers.db, now), recheckOpenPullRequests(deps, api.providers.db, now)]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const rows = await api.providers.db.select({ state: threadPullRequests.state }).from(threadPullRequests);
  expect(rows).toEqual([{ state: "merged" }, { state: "merged" }]);
});

it("bounds fallback work and backs off malformed provider responses", async () => {
  api = await bootTestApi();
  const thread = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { id: string; sessionId: string };
  const now = Date.now();
  for (let number = 1; number <= 7; number++) await recordThreadPullRequest(api.providers.db, { sessionId: thread.sessionId, threadId: thread.id, url: `https://github.com/acme/app/pull/${number}` }, now - PULL_REQUEST_RECHECK_MS - 1);
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", { type: "oauth2", accessToken: "org-token" });
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("bad json"));
  const deps = { db: api.providers.db, credentials: api.providers.engineCredentials, key: Buffer.alloc(32), env: {}, fetchImpl };
  await recheckOpenPullRequests(deps, api.providers.db, now);
  expect(fetchImpl).toHaveBeenCalledTimes(5);
  await recheckOpenPullRequests(deps, api.providers.db, now);
  expect(fetchImpl).toHaveBeenCalledTimes(7);
  await recheckOpenPullRequests(deps, api.providers.db, now);
  expect(fetchImpl).toHaveBeenCalledTimes(7);
});

it("isolates org credentials and lets a webhook win during a fallback fetch", async () => {
  api = await bootTestApi();
  const now = Date.now();
  const url = "https://github.com/acme/app/pull/8";
  for (const orgId of ["org-a", "org-b"]) {
    await api.providers.db.insert(orgs).values({ id: orgId, name: orgId, createdAt: now });
    await api.providers.db.insert(agentSessions).values({ id: orgId, orgId, userId: "local-user", workspace: "test", createdAt: now, updatedAt: now });
    await recordThreadPullRequest(api.providers.db, { sessionId: orgId, threadId: orgId, url }, now - PULL_REQUEST_RECHECK_MS - 1);
    await api.providers.engineCredentials.save({ type: "org", id: orgId }, "github", { type: "oauth2", accessToken: orgId });
  }
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const token = new Headers(init?.headers).get("authorization");
    if (token === "Bearer org-a") {
      await setPullRequestState(api!.providers.db, "org-a", url, "open", now + 1);
      return Response.json({ html_url: url, state: "closed", merged: true });
    }
    expect(token).toBe("Bearer org-b");
    return Response.json({ html_url: url, state: "closed", merged: false });
  });
  await recheckOpenPullRequests({ db: api.providers.db, credentials: api.providers.engineCredentials, key: Buffer.alloc(32), env: {}, fetchImpl }, api.providers.db, now);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect((await api.providers.db.select().from(threadPullRequests).where(eq(threadPullRequests.sessionId, "org-a")))[0]?.state).toBe("open");
  expect((await api.providers.db.select().from(threadPullRequests).where(eq(threadPullRequests.sessionId, "org-b")))[0]?.state).toBe("closed");
});


it("runs without reads, prevents overlapping ticks, and drains on shutdown", async () => {
  api = await bootTestApi();
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({ id: "sweep-session", orgId: "local-org", userId: "local-user", workspace: "test", createdAt: now, updatedAt: now });
  await recordThreadPullRequest(api.providers.db, { sessionId: "sweep-session", threadId: "thread", url: "https://github.com/acme/app/pull/1" }, now - PULL_REQUEST_RECHECK_MS - 1);
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", { type: "oauth2", accessToken: "token" });
  let finish: (response: Response) => void = () => { throw new Error("The provider request has not started"); };
  const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const sweep = startPullRequestSweep({ db: api.providers.db, credentials: api.providers.engineCredentials, key: Buffer.alloc(32), env: {}, fetchImpl }, api.providers.db);
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    await expect.poll(() => fetchImpl.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    let drained = false;
    const stopped = sweep.stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish(new Response(null, { status: 503 }));
    await stopped;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    finish(new Response(null, { status: 503 }));
    await sweep.stop();
    vi.useRealTimers();
  }
});

it("lists stale pull requests without resolving credentials or claiming work", async () => {
  api = await bootTestApi();
  const thread = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { id: string; sessionId: string };
  const staleAt = Date.now() - PULL_REQUEST_RECHECK_MS - 1;
  await recordThreadPullRequest(api.providers.db, { sessionId: thread.sessionId, threadId: thread.id, url: "https://github.com/acme/app/pull/9" }, staleAt);
  const credentials = vi.spyOn(api.providers.engineCredentials, "get");
  try {
    expect((await fetch(`${api.baseUrl}/api/sessions/${thread.sessionId}/threads`)).status).toBe(200);
    expect(credentials).not.toHaveBeenCalled();
    expect((await api.providers.db.select().from(threadPullRequests))[0]?.checkedAt).toBe(staleAt);
  } finally {
    credentials.mockRestore();
  }
});

it("names the child that opened a pull request on the delegating thread's copy only", async () => {
  api = await bootTestApi();
  const parent = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { id: string; sessionId: string };
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: "child-1", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active",
    ownerType: "user", ownerId: "local-user", title: "Investigate OpenAI images", createdAt: now, updatedAt: now,
  });
  await api.providers.db.insert(childWatches).values({
    childSessionId: "child-1", queueItemId: "q-1", parentSessionId: parent.sessionId, parentThreadId: parent.id,
    actorUserId: "local-user", orgId: "local-org", createdAt: now,
  });
  const url = "https://github.com/acme/app/pull/852";
  await recordDelegatedPullRequest(api.providers.db, { sessionId: "child-1", threadId: "child-thread", url });

  const onParent = (await listThreadActivity(api.providers.db, "local-user", parent.sessionId, [parent.id])).get(parent.id)?.pullRequests;
  expect(onParent).toEqual([{ url, repo: "acme/app", number: 852, state: "open",
    delegatedFrom: { sessionId: "child-1", threadId: "child-thread", title: "Investigate OpenAI images" } }]);
  const onChild = (await listThreadActivity(api.providers.db, "local-user", "child-1", ["child-thread"])).get("child-thread")?.pullRequests;
  expect(onChild).toEqual([{ url, repo: "acme/app", number: 852, state: "open" }]);
});

it("treats a pull request recorded before the opening thread was kept as the thread's own", async () => {
  api = await bootTestApi();
  const thread = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { id: string; sessionId: string };
  const url = "https://github.com/acme/app/pull/3";
  await recordThreadPullRequest(api.providers.db, { sessionId: thread.sessionId, threadId: thread.id, url });
  await api.providers.db.update(threadPullRequests).set({ openedSessionId: null, openedThreadId: null }).where(eq(threadPullRequests.url, url));
  const prs = (await listThreadActivity(api.providers.db, "local-user", thread.sessionId, [thread.id])).get(thread.id)?.pullRequests;
  expect(prs).toEqual([{ url, repo: "acme/app", number: 3, state: "open" }]);
});
