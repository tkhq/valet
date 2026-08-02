import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, sessionThreads } from "../schema/index.js";
import { autoTitle, sanitizeTitle } from "./auto-title.js";

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

// Real PGlite instead of a stubbed drizzle chain — the fluent-API stub
// needed banned double-casts and broke whenever autoTitle's query shape
// changed (exactly the shape drift a stub can't catch).
describe("autoTitle", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  async function seedSession(title: string | null, id = "s1", userId = "u1") {
    await db.insert(agentSessions).values({
      id,
      userId,
      orgId: "org1",
      workspace: "demo",
      title,
      createdAt: 1,
      updatedAt: 1,
    });
  }

  async function sessionTitle(id = "s1"): Promise<string | null> {
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
    return row?.title ?? null;
  }

  async function threadTitle(id: string): Promise<string | null> {
    const [row] = await db.select().from(sessionThreads).where(eq(sessionThreads.id, id)).limit(1);
    return row?.title ?? null;
  }

  it("404s when the session isn't owned", async () => {
    await seedSession(null, "s1", "someone-else");
    const result = await autoTitle(
      { db, loadMessages: async () => [], namer: async () => "Unused" },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result).toEqual({ ok: false, reason: "session_not_found" });
  });

  it("returns already_titled when session has a meaningful title and no thread was asked", async () => {
    await seedSession("Deploy the k8s chart");
    const namer = vi.fn();
    const result = await autoTitle(
      { db, loadMessages: async () => [], namer },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result).toEqual({ ok: false, reason: "already_titled" });
    expect(namer).not.toHaveBeenCalled();
  });

  it("treats null / '' / 'Untitled session' as un-titled", async () => {
    for (const title of [null, "", "Untitled session"]) {
      ({ appDb: db } = await freshTestPgDb());
      await seedSession(title);
      const result = await autoTitle(
        {
          db,
          loadMessages: async () => [
            { role: "user", content: "help me fix the CI" },
            { role: "assistant", content: "looking at the failures now" },
          ],
          namer: async () => "Fix the CI",
          now: () => 42,
        },
        { sessionId: "s1", userId: "u1" },
      );
      expect(result).toEqual({ ok: true, sessionTitle: "Fix the CI", threadTitle: null });
      expect(await sessionTitle()).toBe("Fix the CI");
    }
  });

  it("returns no_messages when the session is empty", async () => {
    await seedSession(null);
    const result = await autoTitle(
      { db, loadMessages: async () => [], namer: vi.fn() },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result).toEqual({ ok: false, reason: "no_messages" });
  });

  it("writes thread title only when the thread is un-titled (upserts the mirror row)", async () => {
    await seedSession(null);
    // No session_threads row for th1 yet — the upsert must create it.
    const result = await autoTitle(
      {
        db,
        loadMessages: async () => [{ role: "user", content: "hi" }],
        namer: async () => "Greeting demo",
        now: () => 1,
      },
      { sessionId: "s1", userId: "u1", threadId: "th1" },
    );
    expect(result).toEqual({ ok: true, sessionTitle: "Greeting demo", threadTitle: "Greeting demo" });
    expect(await threadTitle("th1")).toBe("Greeting demo");
  });

  it("does not overwrite an existing thread title", async () => {
    await seedSession(null);
    await db.insert(sessionThreads).values({
      id: "th1",
      sessionId: "s1",
      title: "User-picked name",
      createdAt: 1,
    });
    const result = await autoTitle(
      {
        db,
        loadMessages: async () => [{ role: "user", content: "hi" }],
        namer: async () => "Something else",
        now: () => 1,
      },
      { sessionId: "s1", userId: "u1", threadId: "th1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.threadTitle).toBeNull();
    expect(await threadTitle("th1")).toBe("User-picked name");
  });
});
