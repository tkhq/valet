import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { pgDbFromPglite, type PgDb } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

/**
 * The API records a workflow LLM step's model call as a `usage` row in
 * `engine_entries` so the usage projection counts it (api
 * `workflows/step-usage.ts`). The row has no engine entry shape, so the
 * store's entry readers skip it instead of failing on an unknown type.
 */
describe("usage rows in engine_entries", () => {
  let db: PgDb;
  let store: PgSessionStore;

  beforeAll(async () => {
    db = pgDbFromPglite(new PGlite());
    await applyEngineMigrations(db);
    store = new PgSessionStore(db);
    await store.saveSession({
      id: "wf:run-1:summarize", owner: { type: "user", id: "u1" }, userId: "u1", orgId: "o1",
      workspace: "/", purpose: "workflow", status: "running", createdAt: 1, updatedAt: 1,
    });
    await store.saveThread("wf:run-1:summarize", {
      id: "wf:run-1:summarize", sessionId: "wf:run-1:summarize", key: "default", status: "active",
      queueMode: "followup", createdAt: 1, updatedAt: 1,
    });
    const message: MessageEntry = {
      id: "e-message", sessionId: "wf:run-1:summarize", threadId: "wf:run-1:summarize", parentId: null,
      type: "message", role: "assistant", content: "done", createdAt: 1000,
    };
    await store.appendEntries("wf:run-1:summarize", "wf:run-1:summarize", [message]);
    await db.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, model, usage, cost, created_at)
      VALUES ('e-usage', 'wf:run-1:summarize', 'wf:run-1:summarize', 'usage', 'claude', '{"total":10}', '{"total":0.01}', 2000)`);
  });

  it("skips them in thread history, its tail, and the thread snapshot", async () => {
    const ids = (entries: { id: string }[]) => entries.map((e) => e.id);
    expect(ids(await store.getEntries("wf:run-1:summarize", "wf:run-1:summarize"))).toEqual(["e-message"]);
    expect(ids(await store.getEntries("wf:run-1:summarize", "wf:run-1:summarize", { limit: 1 }))).toEqual(["e-message"]);
    const snapshot = await store.getThreadSnapshot("wf:run-1:summarize", "wf:run-1:summarize");
    expect(ids(snapshot?.entries ?? [])).toEqual(["e-message"]);
  });
});
