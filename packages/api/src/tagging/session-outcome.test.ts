import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventStream, type MessageEntry } from "@valet/engine";
import { PgSessionStore } from "@valet/store-postgres";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { eq } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, tagJobs, tagLabels } from "../schema/index.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
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
const subject = { type: "session", id: "session", text: "user: Deliver the patch. assistant: The patch is delivered.", userId: "alice", ownerType: "user" as const, ownerId: "alice" };

describe("closed session outcomes", () => {
  it.each(["completed", "partial", "failed", "blocked_on_human", "abandoned", "unclear"])("accepts the defined %s key", async key => {
    const tagger = new Tagger({ db: fixture.appDb, orgId: "org", dimensions: [sessionOutcomeDimension], classify: async () => result(key), renderers: new Map() });
    await tagger.tag("session_outcome", [subject]);
    expect((await tagger.labelsFor("session", "session"))[0]).toMatchObject({ key, confidence: .95 });
  });
  it("never accepts new outcome keys and skips unchanged input", async () => {
    const classify = vi.fn<Classify>().mockResolvedValue({ model: "mock", text: JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "shipped", confidence: 1 }] }], newKeys: [{ key: "shipped", label: "Shipped", definition: "Work shipped." }] }) });
    const tagger = new Tagger({ db: fixture.appDb, orgId: "org", dimensions: [sessionOutcomeDimension], classify, renderers: new Map() });
    await tagger.tag("session_outcome", [subject]);
    await tagger.tag("session_outcome", [subject]);
    expect(classify).toHaveBeenCalledOnce();
    expect((await tagger.labelsFor("session", "session"))[0]?.key).toBe("other");
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
    const rendered = await renderer([{ type: "session", id: "session" }]);
    expect(rendered[0]).toMatchObject({ userId: "alice", ownerType: "team", ownerId: "team" });
    expect(rendered[0]?.text).toContain("Summary: The requested patch is ready for validation.");
    expect(await sessionOutcomeRenderer(db, store, "foreign")([{ type: "session", id: "session" }])).toEqual([]);
    await db.update(agentSessions).set({ userId: "team:team" }).where(eq(agentSessions.id, "session"));
    expect((await renderer([{ type: "session", id: "session" }]))[0]).toMatchObject({ userId: null, ownerType: "team", ownerId: "team" });
    await db.update(agentSessions).set({ status: "deleted" }).where(eq(agentSessions.id, "session"));
    expect(await renderer([{ type: "session", id: "session" }])).toEqual([]);
  });
  it("aggregates latest labels with personal, team, organization, and period filters", async () => {
    const db = fixture.appDb;
    await db.insert(agentSessions).values([
      { id: "personal", orgId: "org", userId: "alice", ownerType: "user", ownerId: "alice", workspace: "test", createdAt: 1, updatedAt: 1 },
      { id: "team-session", orgId: "org", userId: "bob", ownerType: "team", ownerId: "team", workspace: "test", createdAt: 1, updatedAt: 1 },
      { id: "foreign", orgId: "foreign-org", userId: "alice", ownerType: "user", ownerId: "alice", workspace: "test", createdAt: 1, updatedAt: 1 },
    ]);
    const tagger = new Tagger({ db, orgId: "org", dimensions: [sessionOutcomeDimension], classify: async request => ({ model: "mock", text: JSON.stringify({ subjects: request.subjects.map((_row, index) => ({ index, labels: [{ key: "completed", confidence: 1 }] })) }) }), renderers: new Map() });
    await tagger.tag("session_outcome", [{ ...subject, id: "personal" }, { ...subject, id: "team-session", userId: "bob", ownerType: "team", ownerId: "team" }]);
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
    await db.insert(agentSessions).values({ id: "session", orgId: "org", userId: "alice", workspace: "test", createdAt: 1, updatedAt: 1 });
    const stop = wireSessionOutcomeTagging(events, db);
    try {
      const emit = async (status: "thinking" | "idle" | "blocked_on_decision_gate") => events.append({ sessionId: "session", threadId: "thread", timestamp: Date.now(), event: { type: "status", threadId: "thread", status } }, `status:${status}`);
      await emit("thinking"); expect(await db.select().from(tagJobs)).toHaveLength(0);
      await emit("idle"); await vi.waitFor(async () => expect(await db.select().from(tagJobs)).toHaveLength(1));
      await emit("blocked_on_decision_gate");
      await events.append({ sessionId: "session", threadId: "thread", timestamp: Date.now(), event: { type: "submission_settled", sessionId: "session", threadId: "thread", queueItemId: "q", outcome: { outcome: "completed" } } }, "settled:q");
      await vi.waitFor(async () => expect((await db.select().from(tagJobs))[0]?.version).toBe(3));
    } finally { stop(); }
  });
});

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; vi.unstubAllEnvs(); });
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
