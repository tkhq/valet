import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventStream, type MessageEntry } from "@valet/engine";
import { PgSessionStore } from "@valet/store-postgres";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { eq, sql } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, tagJobs, tagLabels } from "../schema/index.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import * as availability from "./availability.js";
import { sessionOutcomeDimension, renderSessionOutcomeText, sessionOutcomeRenderer, wireSessionOutcomeTagging } from "./session-outcome.js";
import { Tagger } from "./tagger.js";
import type { Classify } from "./classifier.js";
import { createTagger } from "./worker.js";
import { sessionOutcomeUsage } from "./usage.js";
import { resolveUsagePeriod } from "../services/usage-period.js";
import type { SessionOutcomeUsage } from "../wire/types.js";

let fixture: Awaited<ReturnType<typeof freshTestPgDb>>;
beforeEach(async () => { fixture = await freshTestPgDb(); });
const message = (id: string, role: "user" | "assistant", content: string, createdAt = 1): MessageEntry => ({ id, sessionId: "session", threadId: "thread", parentId: null, createdAt, type: "message", role, content });
const result = (key: string) => ({ model: "mock-small", text: JSON.stringify({ subjects: [{ index: 0, labels: [{ key, confidence: 0.95 }] }] }) });
const subject = { type: "session_thread", id: "session:thread", text: "user: Deliver the patch. assistant: The patch is delivered.", userId: "alice", ownerType: "user" as const, ownerId: "alice" };

describe("closed session outcomes", () => {
  it.each(["completed", "partial", "failed", "blocked_on_human", "abandoned", "unclear"])("accepts the defined %s key", async key => {
    const tagger = new Tagger({ db: fixture.appDb, orgId: "org", dimensions: [sessionOutcomeDimension], classify: async () => result(key), renderers: new Map() });
    await tagger.tag("session_outcome", [subject]);
    expect((await tagger.labelsFor("session_thread", "session:thread"))[0]).toMatchObject({ key, confidence: .95 });
  });
  it("never accepts new outcome keys and skips unchanged input", async () => {
    const classify = vi.fn<Classify>().mockResolvedValue({ model: "mock", text: JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "shipped", confidence: 1 }] }], newKeys: [{ key: "shipped", label: "Shipped", definition: "Work shipped." }] }) });
    const tagger = new Tagger({ db: fixture.appDb, orgId: "org", dimensions: [sessionOutcomeDimension], classify, renderers: new Map() });
    await tagger.tag("session_outcome", [subject]);
    await tagger.tag("session_outcome", [subject]);
    expect(classify).toHaveBeenCalledOnce();
    expect((await tagger.labelsFor("session_thread", "session:thread"))[0]?.key).toBe("other");
    expect((await tagger.registry.list("session_outcome")).some(key => key.key === "shipped")).toBe(false);
    await tagger.tag("session_outcome", [{ ...subject, text: subject.text + " A new request arrived." }]);
    expect(classify).toHaveBeenCalledTimes(2);
  });
  it("caps summary and recent turns while preserving the newest result and excluding tool content", () => {
    const text = renderSessionOutcomeText("Goal: finish the patch.\n" + "x".repeat(2000), [message("old", "user", "Old text ".repeat(2000)), message("new", "assistant", "Done.\nThe verified patch is delivered.", 2), { ...message("tool", "assistant", ""), role: "tool", content: "private raw tool result" }], "settled (completed)");
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024);
    expect(text).toContain("Goal: finish the patch.");
    expect(text).toContain("The verified patch is delivered.");
    expect(text).toContain("⏎"); expect(text).not.toContain("private raw tool result");
  });
  it("renders the latest compaction and tail without crossing organizations or including accounting sessions", async () => {
    const db = fixture.appDb; const store = new PgSessionStore(fixture.pgdb);
    await db.insert(agentSessions).values({ id: "session", orgId: "org", userId: "alice", ownerType: "team", ownerId: "team", workspace: "test", createdAt: 1, updatedAt: 1 });
    await store.saveThread("session", { id: "thread", sessionId: "session", key: "web:default", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 2 });
    await store.appendEntries("session", "thread", [message("user", "user", "Finish the patch."), { id: "compact", sessionId: "session", threadId: "thread", type: "compaction", summary: "The requested patch is ready for validation.", coveredEntryIds: ["user"], tokenCountBefore: 100, tokenCountAfter: 20, parentId: "user", createdAt: 2 }, message("assistant", "assistant", "The tests passed and the patch is ready.", 3)]);
    const renderer = sessionOutcomeRenderer(db, store, "org");
    const rendered = await renderer([{ type: "session_thread", id: "session:thread" }]);
    expect(rendered[0]).toMatchObject({ userId: "alice", ownerType: "team", ownerId: "team" });
    expect(rendered[0]?.text).toContain("Summary: The requested patch is ready for validation.");
    expect(await sessionOutcomeRenderer(db, store, "foreign")([{ type: "session_thread", id: "session:thread" }])).toEqual([]);
    await db.update(agentSessions).set({ userId: "team:team" }).where(eq(agentSessions.id, "session"));
    expect((await renderer([{ type: "session_thread", id: "session:thread" }]))[0]).toMatchObject({ userId: null, ownerType: "team", ownerId: "team" });
    await db.update(agentSessions).set({ status: "deleted" }).where(eq(agentSessions.id, "session"));
    expect(await renderer([{ type: "session_thread", id: "session:thread" }])).toEqual([]);
  });
  it("aggregates latest labels with personal, team, organization, and period filters", async () => {
    const db = fixture.appDb;
    await db.insert(agentSessions).values([
      { id: "personal", orgId: "org", userId: "alice", ownerType: "user", ownerId: "alice", workspace: "test", createdAt: 1, updatedAt: 1 },
      { id: "team-session", orgId: "org", userId: "bob", ownerType: "team", ownerId: "team", workspace: "test", createdAt: 1, updatedAt: 1 },
      { id: "foreign", orgId: "foreign-org", userId: "alice", ownerType: "user", ownerId: "alice", workspace: "test", createdAt: 1, updatedAt: 1 },
    ]);
    const store = new PgSessionStore(fixture.pgdb);
    for (const id of ["personal", "team-session", "foreign"]) await store.saveThread(id,
      { id: `thread-${id}`, sessionId: id, key: "web:default", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
    const tagger = new Tagger({ db, orgId: "org", dimensions: [sessionOutcomeDimension], classify: async request => ({ model: "mock", text: JSON.stringify({ subjects: request.subjects.map((_row, index) => ({ index, labels: [{ key: "completed", confidence: 1 }] })) }) }), renderers: new Map() });
    await tagger.tag("session_outcome", [{ ...subject, id: "personal:thread-personal" }, { ...subject, id: "team-session:thread-team-session", userId: "bob", ownerType: "team", ownerId: "team" }]);
    const resolved = resolveUsagePeriod({ window: "7d" });
    if (!resolved.ok) throw new Error(resolved.error.message);
    const period = resolved.period;
    const mine = await sessionOutcomeUsage(db, { scope: "me", orgId: "org", userId: "alice" }, period);
    const team = await sessionOutcomeUsage(db, { scope: "team", orgId: "org", teamId: "team", byMember: false }, period);
    const org = await sessionOutcomeUsage(db, { scope: "org", orgId: "org" }, period);
    expect(mine.outcomes.find(row => row.key === "completed")?.sessions).toBe(1);
    expect(team.outcomes.find(row => row.key === "completed")?.sessions).toBe(1);
    expect(org.outcomes.find(row => row.key === "completed")?.sessions).toBe(2);
    await db.update(tagLabels).set({ classifiedAt: 1 });
    expect((await sessionOutcomeUsage(db, { scope: "org", orgId: "org" }, period)).outcomes.every(row => row.sessions === 0)).toBe(true);
  });
  it("enqueues terminal, idle, and human-blocked states on the existing event stream", async () => {
    const db = fixture.appDb; const events = new InMemoryEventStream();
    vi.spyOn(availability, "taggingAvailable").mockResolvedValue(true);
    await db.insert(agentSessions).values({ id: "session", orgId: "org", userId: "alice", workspace: "test", createdAt: 1, updatedAt: 1 });
    const stop = wireSessionOutcomeTagging(events, db);
    try {
      const emit = async (status: "thinking" | "idle" | "blocked_on_decision_gate") => events.append({ sessionId: "session", threadId: "thread", timestamp: Date.now(), event: { type: "status", threadId: "thread", status } }, `status:${status}`);
      await emit("thinking"); expect(await db.select().from(tagJobs)).toHaveLength(0);
      await emit("idle"); await vi.waitFor(async () => expect(await db.select().from(tagJobs)).toHaveLength(1));
      await emit("blocked_on_decision_gate");
      await events.append({ sessionId: "session", threadId: "thread", timestamp: Date.now(), event: { type: "submission_settled", sessionId: "session", threadId: "thread", queueItemId: "q", outcome: { outcome: "completed" } } }, "settled:q");
      await vi.waitFor(async () => expect((await db.select().from(tagJobs))[0]?.version).toBe(3));
      expect((await db.select().from(tagJobs))[0]).toMatchObject({ subjectType: "session_thread", subjectId: "session:thread" });
      expect((await db.select().from(tagJobs))[0]!.nextAttemptAt).toBeGreaterThanOrEqual(Date.now() + 599000);
    } finally { stop(); }
  });
});

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("finishes a real local session, tags it through XS provider resolution, and serves the scoped outcome card", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-fixture-key");
  const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  try {
    api = await bootTestApi();
    faux.setResponses([fauxAssistantMessage("The requested answer is 4. The task is complete.")]);
    const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const thread = await created.json() as { id: string; sessionId: string };
    const sent = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "What is 2 + 2?" }) });
    const receipt = await sent.json() as { messageId: string };
    const outcome = await api.providers.engineHost.liveSession(thread.sessionId)?.thread(thread.id).awaitResult(receipt.messageId);
    expect(outcome?.outcome).toBe("completed");
    await vi.waitFor(async () => expect((await api!.providers.db.select().from(tagJobs)).some(row => row.dimension === "session_outcome")).toBe(true));
    faux.setResponses([fauxAssistantMessage(result("completed").text)]);
    await api.providers.db.update(tagJobs).set({ nextAttemptAt: Date.now() });
    await createTagger(api.providers.db, api.providers.engineCredentials, "local-org", api.providers.engineStore).drain("session_outcome");
    expect((await api.providers.db.select().from(tagLabels))[0]?.key).toBe("completed");
    const mine = await (await fetch(`${api.baseUrl}/api/usage/session-outcomes?window=7d`)).json() as SessionOutcomeUsage;
    expect(mine.outcomes.find(row => row.key === "completed")?.sessions).toBe(1);
    const theirs = await (await fetch(`${api.baseUrl}/api/usage/session-outcomes?window=7d`, { headers: { "x-valet-test-user-id": "test-member" } })).json() as SessionOutcomeUsage;
    expect(theirs.outcomes.every(row => row.sessions === 0)).toBe(true);
    expect((await fetch(`${api.baseUrl}/api/usage/session-outcomes?window=7d&scope=org`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(403);
    expect((await fetch(`${api.baseUrl}/api/usage/session-outcomes?window=7d&scope=team`)).status).toBe(400);
  } finally { faux.unregister(); }
});

it("renders only the event thread, labels human gates, and skips running, queued, and workflow work", async () => {
  const db = fixture.appDb; const store = new PgSessionStore(fixture.pgdb);
  for (const id of ["session", "wf:run:step"]) await db.insert(agentSessions).values({ id, orgId: "org", userId: "alice",
    ownerType: "user", ownerId: "alice", workspace: "test", createdAt: 1, updatedAt: 1 });
  for (const [id, sessionId] of [["thread", "session"], ["unrelated", "session"], ["step", "wf:run:step"]] as const) {
    await store.saveThread(sessionId, { id, sessionId, key: id, status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
    await store.appendEntries(sessionId, id, [{ ...message(`user-${id}`, "user", id === "unrelated" ? "Private unrelated request." : "Deliver the patch."), sessionId, threadId: id },
      { ...message(`assistant-${id}`, "assistant", id === "unrelated" ? "Secret unrelated result." : "Please approve the pending gate."), sessionId, threadId: id },
      { ...message(`empty-${id}`, "assistant", ""), sessionId, threadId: id }]);
  }
  await fixture.pgdb.query(`INSERT INTO engine_queue_items(id,session_id,thread_id,status,content,attempt_count,max_attempts,timeout_at,created_at,updated_at)
    VALUES ('gate','session','thread','blocked_on_decision_gate','Deliver the patch.',0,3,0,1,1)`);
  const render = sessionOutcomeRenderer(db, store, "org");
  const ref = { type: "session_thread", id: "session:thread" };
  const subjects = await render([ref]);
  expect(subjects[0]?.text).toContain("blocked_on_decision_gate");
  expect(subjects[0]?.text).not.toContain("unrelated");
  expect(subjects[0]?.text.split("\n")).not.toContain("assistant:");
  const tagger = new Tagger({ db, orgId: "org", dimensions: [sessionOutcomeDimension], renderers: new Map([["session_thread", render]]),
    classify: async () => result("blocked_on_human") });
  await tagger.tag("session_outcome", subjects);
  expect((await tagger.labelsFor(ref.type, ref.id))[0]?.key).toBe("blocked_on_human");
  for (const status of ["running", "queued"]) {
    await fixture.pgdb.query("UPDATE engine_queue_items SET status=$1 WHERE id='gate'", [status]);
    expect(await render([ref])).toEqual([]);
  }
  expect(await render([{ type: "session_thread", id: "wf:run:step:step" }])).toEqual([]);
});

it("caps successful re-tags at three per subject per UTC day without retrying a capped job", async () => {
  const db = fixture.appDb;
  let current = { ...subject };
  const classify = vi.fn<Classify>(async () => result("partial"));
  const tagger = new Tagger({ db, orgId: "org", dimensions: [sessionOutcomeDimension], classify,
    renderers: new Map([["session_thread", async () => [current]]]) });
  await tagger.tag("session_outcome", [current]);
  for (let i = 0; i < 3; i++) await tagger.tag("session_outcome", [{ ...current, text: `Changed turn ${i}.` }]);
  current = { ...current, text: "One more settled result." };
  await tagger.enqueueTagging("session_outcome", [current]);
  expect(await tagger.drain("session_outcome")).toBe(1);
  expect(classify).toHaveBeenCalledTimes(4);
  expect(await db.select().from(tagJobs)).toHaveLength(0);
  await db.execute(sql`UPDATE tag_subjects SET retag_day = retag_day - 1`);
  await tagger.tag("session_outcome", [current]); expect(classify).toHaveBeenCalledTimes(5);
});
