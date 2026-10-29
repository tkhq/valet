import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { entriesToAgentMessages, skillInvocationsInContext, type SessionEntry } from "@valet/engine";
import { pgDbFromPglite } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

const S = "sess-1";
const T = "thread-1";
const MODEL = { api: "anthropic-messages", provider: "anthropic", id: "claude-test" };

function message(id: string, parentId: string | null, role: "user" | "assistant", createdAt: number, queueItemId: string): SessionEntry {
  const text = `${id} `.padEnd(2_000, "x");
  return { id, sessionId: S, threadId: T, parentId, type: "message", role, content: text, parts: [{ type: "text", text }], createdAt, queueItemId };
}

describe("getTranscriptSnapshot", () => {
  let store: PgSessionStore;

  beforeEach(async () => {
    const db = pgDbFromPglite(new PGlite());
    await applyEngineMigrations(db);
    store = new PgSessionStore(db);
    await store.saveSession({
      id: S, owner: { type: "user", id: "u1" }, userId: "u1", orgId: "o1", workspace: "/", purpose: "orchestrator", status: "running", createdAt: 1, updatedAt: 1,
    });
  });

  async function seed(activeLeafEntryId: string, extra: SessionEntry[] = []) {
    await store.saveThread(S, { id: T, sessionId: S, key: "default", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
    const entries: SessionEntry[] = [
      message("m1", null, "user", 1, "q1"),
      message("m2", "m1", "assistant", 2, "q1"),
      message("m3", "m2", "user", 3, "q2"),
      message("m4", "m3", "assistant", 4, "q2"),
      {
        id: "c1", sessionId: S, threadId: T, parentId: "m4", type: "compaction", summary: "earlier work",
        coveredEntryIds: ["m1", "m2", "m3", "m4"], tokenCountBefore: 4_000, tokenCountAfter: 100, createdAt: 5,
      },
      message("m5", "c1", "user", 6, "q3"),
      message("m6", "m5", "assistant", 7, "q3"),
      ...extra,
    ];
    await store.appendEntries(S, T, entries);
    const thread = await store.getThread(S, T);
    await store.saveThread(S, { ...thread!, activeLeafEntryId });
  }

  async function both(keepQueueItemId?: string) {
    const full = await store.getThreadSnapshot(S, T);
    const live = await store.getTranscriptSnapshot(S, T, keepQueueItemId === undefined ? undefined : { keepQueueItemId });
    if (!full || !live) throw new Error("Expected both snapshots");
    const leaf = full.thread.activeLeafEntryId;
    const render = (entries: SessionEntry[]) => entriesToAgentMessages(entries, MODEL, { activeLeafEntryId: leaf, taskSourceQueueItemId: keepQueueItemId });
    return { full, live, leaf, render };
  }

  it("stubs entries the active compaction covers and rebuilds the same transcript", async () => {
    await seed("m6");
    const { full, live, leaf, render } = await both();
    expect(live.entries.map((e) => e.id)).toEqual(full.entries.map((e) => e.id));
    const byId = new Map(live.entries.map((e) => [e.id, e]));
    for (const id of ["m1", "m2", "m3", "m4"]) {
      const entry = byId.get(id);
      expect(entry?.type === "message" ? [entry.content, entry.parts] : null).toEqual(["", undefined]);
    }
    const live6 = byId.get("m6");
    expect(live6?.type === "message" ? live6.content : "").toContain("m6 ");
    expect(render(live.entries)).toEqual(render(full.entries));
    expect(skillInvocationsInContext(live.entries, leaf)).toEqual(skillInvocationsInContext(full.entries, leaf));
  });

  it("keeps a covered task-source prompt whole", async () => {
    await seed("m6");
    const { live, render, full } = await both("q1");
    const prompt = live.entries.find((e) => e.id === "m1");
    expect(prompt?.type === "message" ? prompt.content : "").toContain("m1 ");
    expect(render(live.entries)).toEqual(render(full.entries));
  });

  it("stubs nothing on a branch that left before the compaction", async () => {
    await seed("b1", [message("b1", "m2", "user", 8, "q4")]);
    const { full, live, render } = await both();
    expect(live.entries).toEqual(full.entries);
    expect(render(live.entries)).toEqual(render(full.entries));
  });
});
