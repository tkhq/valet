/**
 * Principle citations: a turn whose answer or plan names a principle gets a
 * `principle_cited` thread event, and the principle's file counts a cite.
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams } from "../schema/index.js";
import { writeFile, type MemoryScope } from "../services/memory.js";
import { memoryUsageRecorder, readMemoryUsage } from "../services/memory-usage.js";
import { findPrincipleCitations, recordPrincipleCitations } from "./principle-citations.js";

const principles = [
  { path: "principles/prove-it-works.md", title: "Prove it works" },
  { path: "principles/x.md", title: "X" },
  { path: "team:t1/principles/x.md", title: "Ship small changes" },
];

describe("findPrincipleCitations", () => {
  it("finds an explicit path, with or without the extension or a leading slash", () => {
    expect(findPrincipleCitations(["I followed `principles/prove-it-works.md`."], principles))
      .toEqual([{ path: "principles/prove-it-works.md", match: "path" }]);
    expect(findPrincipleCitations(["Per /principles/prove-it-works, I ran the app."], principles))
      .toEqual([{ path: "principles/prove-it-works.md", match: "path" }]);
  });

  it("keeps an own principle apart from a team principle at the same path", () => {
    expect(findPrincipleCitations(["Following team:t1/principles/x.md."], principles))
      .toEqual([{ path: "team:t1/principles/x.md", match: "path" }]);
    expect(findPrincipleCitations(["Following principles/x.md."], principles))
      .toEqual([{ path: "principles/x.md", match: "path" }]);
  });

  it("does not match a longer path that starts with a principle's path", () => {
    expect(findPrincipleCitations(["See principles/prove-it-works-twice.md"], principles)).toEqual([]);
  });

  it("finds the built-in base principle by name", () => {
    expect(findPrincipleCitations(["As learn-from-the-org says, I saved a principle."], principles))
      .toEqual([{ path: "learn-from-the-org", match: "path" }]);
  });

  it("marks a title match as a heuristic, and only for titles of two words or more", () => {
    expect(findPrincipleCitations(["I will ship small changes here."], principles))
      .toEqual([{ path: "team:t1/principles/x.md", match: "title" }]);
    // "X" is one word: too common to match on its own.
    expect(findPrincipleCitations(["Option X is better."], principles)).toEqual([]);
  });

  it("prefers the explicit match and lists each principle once", () => {
    expect(findPrincipleCitations(
      ["Prove it works: principles/prove-it-works.md", "prove it works again"],
      principles,
    )).toEqual([{ path: "principles/prove-it-works.md", match: "path" }]);
  });
});

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

describe("recordPrincipleCitations", () => {
  it("appends one principle_cited event and counts a cite on each cited file", async () => {
    api = await bootTestApi();
    const { db, eventStream } = api.providers;
    const own: MemoryScope = { owner: { type: "user", id: "local-user" }, actorUserId: "local-user" };
    const team: MemoryScope = { owner: { type: "team", id: "t1" }, actorUserId: "local-user" };
    await db.insert(teams).values({ id: "t1", orgId: "local-org", name: "T1", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "t1", userId: "local-user", role: "member" });
    await db.insert(agentSessions).values({ id: "cite-sess", userId: "local-user", orgId: "local-org",
      ownerType: "user", ownerId: "local-user", workspace: "w", createdAt: 1, updatedAt: 1 });
    await writeFile(db, own, { path: "principles/prove-it-works.md", content: "# Prove it works\n" });
    await writeFile(db, team, { path: "principles/ship-small.md", content: "# Ship small changes\n" });
    await writeFile(db, own, { path: "principles/unused.md", content: "# Never cited here\n" });
    const planCall = JSON.stringify([{ type: "tool_call", callId: "c1", toolName: "update_plan", status: "completed",
      args: { items: [{ text: "Ship small changes, one PR", status: "in_progress" }] } }]);
    await db.execute(sql`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, content, parts, queue_item_id, created_at)
      VALUES ('e1', 'cite-sess', 'th1', 'message', 'assistant', '', ${planCall}, 'q1', 1),
             ('e2', 'cite-sess', 'th1', 'message', 'assistant', 'Done. I followed principles/prove-it-works.md.', NULL, 'q1', 2),
             ('e3', 'cite-sess', 'th1', 'message', 'user', 'principles/unused.md', NULL, 'q1', 3)`);

    await recordPrincipleCitations(db, eventStream, { sessionId: "cite-sess", threadId: "th1", queueItemId: "q1" });
    // A second settle for the same submission appends nothing new.
    await recordPrincipleCitations(db, eventStream, { sessionId: "cite-sess", threadId: "th1", queueItemId: "q1" });
    await memoryUsageRecorder(db).flush();

    const { events } = await eventStream.read("cite-sess");
    const cited = events.filter((e) => e.event.type === "principle_cited");
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatchObject({
      threadId: "th1",
      queueItemId: "q1",
      event: {
        type: "principle_cited",
        threadId: "th1",
        citations: [
          { path: "principles/prove-it-works.md", match: "path" },
          { path: "team:t1/principles/ship-small.md", match: "title" },
        ],
      },
    });
    expect((await readMemoryUsage(db, own)).get("principles/prove-it-works.md")).toMatchObject({ citeCount: 1 });
    expect((await readMemoryUsage(db, own)).has("principles/unused.md")).toBe(false);
    expect((await readMemoryUsage(db, team)).get("principles/ship-small.md")).toMatchObject({ citeCount: 1 });
  });

  it("appends nothing when the turn names no principle", async () => {
    api = await bootTestApi();
    const { db, eventStream } = api.providers;
    await db.insert(agentSessions).values({ id: "quiet-sess", userId: "local-user", orgId: "local-org",
      ownerType: "user", ownerId: "local-user", workspace: "w", createdAt: 1, updatedAt: 1 });
    await db.execute(sql`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, content, queue_item_id, created_at)
      VALUES ('e1', 'quiet-sess', 'th1', 'message', 'assistant', 'All done.', 'q1', 1)`);

    await recordPrincipleCitations(db, eventStream, { sessionId: "quiet-sess", threadId: "th1", queueItemId: "q1" });

    const { events } = await eventStream.read("quiet-sess");
    expect(events.filter((e) => e.event.type === "principle_cited")).toEqual([]);
  });
});
