/**
 * The thread-list cap on `GET /api/sessions/:id/threads` (V1 port #13).
 *
 * This is a ceiling, not a pagination system, and the difference is the
 * point. Thread counts were measured before it was written: the busiest
 * session in the sample held five threads, so a cursor would be machinery
 * for a load nobody carries. What it guards is the one generator that human
 * activity does not bound — a workflow `orchestrator` node opens a
 * `signal:workflow:{runId}` thread on EVERY run, so a workflow on a
 * 15-minute schedule adds about 96 threads a day to one session.
 *
 * So the tests below pin three things: the cap holds, it keeps the NEWEST
 * threads, and `total` tells a client what the cap hid.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";
import { threadLimit } from "./messages.js";
import type { CreateThreadResponse, ListThreadsResponse } from "../wire/types.js";

async function seedSession(api: TestApi, id: string): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/threads-${id}`,
    status: "active",
    ownerType: "user",
    ownerId: "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

async function createThreads(api: TestApi, sessionId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as CreateThreadResponse;
    ids.push(body.id);
    // Thread ids sort by creation time, and two created in the same
    // millisecond would make "newest" ambiguous for the assertions below.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return ids;
}

async function listThreads(api: TestApi, sessionId: string, limit?: number): Promise<ListThreadsResponse> {
  const suffix = limit === undefined ? "" : `?limit=${limit}`;
  const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads${suffix}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListThreadsResponse;
}

describe("threadLimit", () => {
  it("defaults when the parameter is absent or unusable", () => {
    for (const raw of [undefined, "", "abc", "0", "-5", "1.5"]) {
      expect(threadLimit(raw)).toBe(100);
    }
  });

  it("honours a usable value", () => {
    expect(threadLimit("5")).toBe(5);
  });

  it("clamps a value that would defeat the cap", () => {
    expect(threadLimit("999999")).toBe(1000);
  });
});

describe("GET /api/sessions/:id/threads — cap", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("returns every thread and a matching total when the session is under the cap", async () => {
    api = await bootTestApi();
    await seedSession(api, "th-small");
    await createThreads(api, "th-small", 3);

    const body = await listThreads(api, "th-small");
    // Three created plus the default thread the route ensures.
    expect(body.threads).toHaveLength(4);
    expect(body.total).toBe(4);
  });

  it("caps the list and reports the full count", async () => {
    api = await bootTestApi();
    await seedSession(api, "th-cap");
    await createThreads(api, "th-cap", 5);

    const body = await listThreads(api, "th-cap", 2);
    expect(body.threads).toHaveLength(2);
    expect(body.total).toBe(6);
  });

  it("keeps the NEWEST threads, so the cap never hides what was just created", async () => {
    // A cap over the engine's hydration order would drop whichever threads
    // happened to load last, which is arbitrary. The newest thread is the
    // one a person is about to click.
    api = await bootTestApi();
    await seedSession(api, "th-newest");
    // One list call first: `GET /threads` calls `ensureDefaultThread`, so
    // the session's default thread is born DURING the first read and would
    // otherwise be the newest of all — a fact worth pinning, since it also
    // means the default thread heads the sidebar on a fresh session.
    await listThreads(api, "th-newest");
    const created = await createThreads(api, "th-newest", 4);
    const newest = created.at(-1);

    const body = await listThreads(api, "th-newest", 1);
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]?.id).toBe(newest);
  });

  it("keeps the newest across the whole list, not only the first row", async () => {
    api = await bootTestApi();
    await seedSession(api, "th-prefix");
    await listThreads(api, "th-prefix");
    await createThreads(api, "th-prefix", 5);

    const full = await listThreads(api, "th-prefix");
    const capped = await listThreads(api, "th-prefix", 3);
    // The capped list is exactly the head of the full list.
    expect(capped.threads.map((t) => t.id)).toEqual(full.threads.slice(0, 3).map((t) => t.id));
  });

  it("returns the list newest first", async () => {
    api = await bootTestApi();
    await seedSession(api, "th-order");
    await createThreads(api, "th-order", 4);

    const body = await listThreads(api, "th-order");
    const stamps = body.threads.map((t) => t.createdAt);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });

  it("raising the limit reveals the rest, which is what the sidebar button does", async () => {
    api = await bootTestApi();
    await seedSession(api, "th-more");
    await createThreads(api, "th-more", 5);

    const first = await listThreads(api, "th-more", 2);
    const second = await listThreads(api, "th-more", 4);
    expect(second.threads).toHaveLength(4);
    // The first page is a prefix of the second — raising the limit adds
    // rows, it does not reshuffle the ones already on screen.
    expect(second.threads.slice(0, 2).map((t) => t.id)).toEqual(first.threads.map((t) => t.id));
  });

  it("counts only the requested set, so archived threads do not inflate the total", async () => {
    api = await bootTestApi();
    await seedSession(api, "th-arch");
    const created = await createThreads(api, "th-arch", 3);
    const archived = created[0];
    await fetch(`${api.baseUrl}/api/sessions/th-arch/threads/${archived}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    const active = await listThreads(api, "th-arch");
    expect(active.total).toBe(active.threads.length);
    expect(active.threads.some((t) => t.id === archived)).toBe(false);
  });

  it("caps the archived set too, and reports its full count", async () => {
    // The archived list is capped by the same parameter. The sidebar has to
    // read `total` there as well: taking the server default and ignoring
    // `total` truncates a list that used to return everything, with no
    // control to reach the rest.
    api = await bootTestApi();
    await seedSession(api, "th-arch-cap");
    const created = await createThreads(api, "th-arch-cap", 4);
    for (const id of created.slice(0, 3)) {
      await fetch(`${api.baseUrl}/api/sessions/th-arch-cap/threads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
    }

    const res = await fetch(`${api.baseUrl}/api/sessions/th-arch-cap/threads?archived=1&limit=2`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as ListThreadsResponse;
    expect(page.threads).toHaveLength(2);
    expect(page.total).toBe(3);

    const all = (await (
      await fetch(`${api.baseUrl}/api/sessions/th-arch-cap/threads?archived=1&limit=50`)
    ).json()) as ListThreadsResponse;
    expect(all.threads).toHaveLength(3);
    expect(all.total).toBe(3);
  });
});
