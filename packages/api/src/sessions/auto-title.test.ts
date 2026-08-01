import { describe, expect, it, vi } from "vitest";
import { autoTitle, sanitizeTitle } from "./auto-title.js";
import type { AppDb } from "../lib/drizzle.js";

describe("sanitizeTitle", () => {
  it("strips wrapping quotes, backticks, and asterisks", () => {
    expect(sanitizeTitle('"Debugging the OAuth Flow"')).toBe("Debugging the OAuth Flow");
    expect(sanitizeTitle("**Ship the feature**")).toBe("Ship the feature");
    expect(sanitizeTitle("`Migrate to Postgres`")).toBe("Migrate to Postgres");
  });
  it("strips trailing punctuation", () => {
    expect(sanitizeTitle("Refactor the picker.")).toBe("Refactor the picker");
    expect(sanitizeTitle("Fix the CI!")).toBe("Fix the CI");
  });
  it("returns null for empty / whitespace", () => {
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("   ")).toBeNull();
  });
  it("caps at MAX_TITLE_CHARS with an ellipsis", () => {
    const long = "a".repeat(120);
    const out = sanitizeTitle(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(60);
    expect(out!.endsWith("…")).toBe(true);
  });
});

/** Minimal in-memory Drizzle stub — just enough surface for `autoTitle` to
 * exercise its query shape without a real database. `select().from().where()
 * .limit()` returns a preloaded row set. `update().set().where()` records
 * the call so the test can assert on writes. */
function makeStubDb(rows: {
  session?: { id: string; userId: string; title: string | null };
  messages?: { role: string; content: string }[];
  thread?: { id: string; title: string | null };
}): { db: AppDb; sessionUpdates: unknown[]; threadUpdates: unknown[] } {
  const sessionUpdates: unknown[] = [];
  const threadUpdates: unknown[] = [];
  const select = (fields?: unknown) => ({
    from: (table: { _label?: string }) => ({
      where: () => ({
        limit: async () => {
          if (table._label === "session") {
            return rows.session ? [rows.session] : [];
          }
          if (table._label === "thread") {
            return rows.thread ? [{ title: rows.thread.title }] : [];
          }
          return [];
        },
        orderBy: () => ({
          limit: async () =>
            table._label === "messages" ? (rows.messages ?? []) : [],
        }),
      }),
    }),
    _fields: fields,
  });
  const update = (table: { _label: string }) => ({
    set: (patch: unknown) => ({
      where: async () => {
        if (table._label === "session") sessionUpdates.push(patch);
        if (table._label === "thread") threadUpdates.push(patch);
      },
    }),
  });
  return {
    db: {
      select,
      update,
    } as unknown as AppDb,
    sessionUpdates,
    threadUpdates,
  };
}

// Match table identity by monkey-labelling the imported symbols.
import { agentSessions, messages, sessionThreads } from "../schema/index.js";
(agentSessions as unknown as { _label: string })._label = "session";
(messages as unknown as { _label: string })._label = "messages";
(sessionThreads as unknown as { _label: string })._label = "thread";

describe("autoTitle", () => {
  it("404s when the session isn't owned", async () => {
    const { db } = makeStubDb({});
    const result = await autoTitle(
      { db, namer: async () => "Unused" },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result).toEqual({ ok: false, reason: "session_not_found" });
  });

  it("returns already_titled when session has a meaningful title and no thread was asked", async () => {
    const { db } = makeStubDb({
      session: { id: "s1", userId: "u1", title: "Deploy the k8s chart" },
    });
    const result = await autoTitle(
      { db, namer: vi.fn() },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result).toEqual({ ok: false, reason: "already_titled" });
  });

  it("treats null / '' / 'Untitled session' as un-titled", async () => {
    for (const title of [null, "", "Untitled session"]) {
      const { db, sessionUpdates } = makeStubDb({
        session: { id: "s1", userId: "u1", title },
        messages: [
          { role: "user", content: "help me fix the CI" },
          { role: "assistant", content: "looking at the failures now" },
        ],
      });
      const result = await autoTitle(
        { db, namer: async () => "Fix the CI", now: () => 42 },
        { sessionId: "s1", userId: "u1" },
      );
      expect(result).toEqual({ ok: true, sessionTitle: "Fix the CI", threadTitle: null });
      expect(sessionUpdates).toEqual([{ title: "Fix the CI", updatedAt: 42 }]);
    }
  });

  it("returns no_messages when the session is empty", async () => {
    const { db } = makeStubDb({
      session: { id: "s1", userId: "u1", title: null },
      messages: [],
    });
    const result = await autoTitle(
      { db, namer: vi.fn() },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result).toEqual({ ok: false, reason: "no_messages" });
  });

  it("writes thread title only when the thread is un-titled", async () => {
    const { db, threadUpdates } = makeStubDb({
      session: { id: "s1", userId: "u1", title: null },
      thread: { id: "th1", title: null },
      messages: [{ role: "user", content: "hi" }],
    });
    await autoTitle(
      { db, namer: async () => "Greeting demo", now: () => 1 },
      { sessionId: "s1", userId: "u1", threadId: "th1" },
    );
    expect(threadUpdates).toEqual([{ title: "Greeting demo" }]);
  });

  it("does not overwrite an existing thread title", async () => {
    const { db, threadUpdates } = makeStubDb({
      session: { id: "s1", userId: "u1", title: null },
      thread: { id: "th1", title: "User-picked name" },
      messages: [{ role: "user", content: "hi" }],
    });
    await autoTitle(
      { db, namer: async () => "Something else", now: () => 1 },
      { sessionId: "s1", userId: "u1", threadId: "th1" },
    );
    expect(threadUpdates).toEqual([]);
  });
});
