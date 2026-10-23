import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgDbFromPglite } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb, missingSchemaRepairs } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { bindConversation, findConversationBinding, hasLegacyHomeConversation, type ConversationScope } from "./conversation-bindings.js";

const scope: ConversationScope = {
  orgId: "org-1", userId: "user-1", sessionId: "session-1", channelType: "slack", conversationKey: "D1:111.1",
};
const threadKey = "slack:D1:111.1";
const indexes = ["engine_queue_items_thread", "engine_entries_thread"];
let directory: string;
let pglite: PGlite;
let pgdb: ReturnType<typeof pgDbFromPglite>;
let db: ReturnType<typeof buildAppDb>;

async function openDatabase() {
  pglite = new PGlite(directory);
  pgdb = pgDbFromPglite(pglite);
  db = buildAppDb(pglite);
  await applyAppMigrations(pgdb);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "conversation-bindings-"));
  await openDatabase();
});

afterAll(async () => {
  await pglite?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function seedSession(value: ConversationScope, ownerType = "user", ownerId = value.userId) {
  await db.insert(agentSessions).values({
    id: value.sessionId, orgId: value.orgId, userId: value.userId, ownerType, ownerId,
    workspace: "/workspace", createdAt: 1, updatedAt: 1,
  });
}

async function seedThread(id: string, sessionId = scope.sessionId) {
  await pgdb.query(`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
    VALUES ($1, $2, $1, 'idle', 'steer', 1, 1)`, [id, sessionId]);
}

beforeEach(async () => {
  await pgdb.query("TRUNCATE engine_queue_items, engine_entries, engine_threads, agent_sessions CASCADE");
  if ((await pgdb.query("SELECT to_regclass('channel_conversation_bindings') AS name")).rows[0]?.name) {
    await pgdb.query("TRUNCATE channel_conversation_bindings");
  }
  await seedSession(scope);
  await seedThread("home");
  await seedThread("native");
});

async function queueItem(options: {
  content?: unknown; channel?: unknown; sessionId?: string; threadId?: string; status?: string;
} = {}) {
  await pgdb.query(`INSERT INTO engine_queue_items
    (id, session_id, thread_id, status, content, channel, attempt_count, max_attempts, timeout_at, created_at, updated_at)
    VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 0, 1, 1000, 1, 1)`, [
    options.sessionId ?? scope.sessionId, options.threadId ?? "home", options.status ?? "queued",
    JSON.stringify(options.content ?? "/pause"), options.channel ? JSON.stringify(options.channel) : null,
  ]);
}

async function entry(signal: unknown, sessionId = scope.sessionId, threadId = "home", content = "old text") {
  await pgdb.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, signal, content, created_at)
    VALUES (gen_random_uuid()::text, $1, $2, 'message', 'user', $3, $4, 1)`,
  [sessionId, threadId, signal === null ? null : JSON.stringify(signal), content]);
}

async function rawQueueItem(content: string, channel: string | null = null) {
  await pgdb.query(`INSERT INTO engine_queue_items
    (id, session_id, thread_id, status, content, channel, attempt_count, max_attempts, timeout_at, created_at, updated_at)
    VALUES (gen_random_uuid()::text, $1, 'home', 'queued', $2, $3, 0, 1, 1000, 1, 1)`,
  [scope.sessionId, content, channel]);
}

const origin = { channelType: "slack", threadKey };

describe("durable conversation bindings", () => {
  it("returns no binding before the first submission", async () => {
    expect(await findConversationBinding(db, scope)).toBeUndefined();
  });

  it.each(["home", "native"])("keeps the first %s mapping across repeated edits and a database restart", async (first) => {
    const other = first === "home" ? "native" : "home";
    expect(await bindConversation(db, scope, first)).toBe(first);
    const original = await pgdb.query("SELECT created_at FROM channel_conversation_bindings");
    await pglite.close();
    await openDatabase();
    for (let edit = 0; edit < 3; edit++) {
      expect(await findConversationBinding(buildAppDb(pglite), scope)).toBe(first);
      expect(await bindConversation(db, scope, other)).toBe(first);
    }
    expect((await pgdb.query("SELECT thread_id, created_at FROM channel_conversation_bindings")).rows)
      .toEqual([{ thread_id: first, created_at: original.rows[0]?.created_at }]);
  });

  it("rereads one immutable winner for concurrent conflicting contenders", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      bindConversation(buildAppDb(pglite), scope, i % 2 === 0 ? "home" : "native")));
    expect(new Set(results).size).toBe(1);
    expect(await findConversationBinding(db, scope)).toBe(results[0]);
    expect((await pgdb.query("SELECT thread_id FROM channel_conversation_bindings")).rows)
      .toEqual([{ thread_id: results[0] }]);
  });

  it("separates roots, channel types, users, organizations, and sessions", async () => {
    const alternatives: ConversationScope[] = [
      { ...scope, conversationKey: "D1:222.2" },
      { ...scope, channelType: "telegram" },
      { ...scope, userId: "user-2", sessionId: "session-2" },
      { ...scope, orgId: "org-2", sessionId: "session-3" },
      { ...scope, sessionId: "session-4" },
    ];
    await bindConversation(db, scope, "home");
    for (const [i, value] of alternatives.entries()) {
      if (value.sessionId !== scope.sessionId) await seedSession(value);
      await seedThread(`native-${i}`, value.sessionId);
      expect(await findConversationBinding(db, value)).toBeUndefined();
      expect(await bindConversation(db, value, `native-${i}`)).toBe(`native-${i}`);
    }
    expect(await findConversationBinding(db, scope)).toBe("home");
  });

  it.each([
    { ...scope, orgId: "org-2" },
    { ...scope, userId: "user-2" },
    { ...scope, sessionId: "missing" },
  ])("rejects a forged binding scope %j", async (value) => {
    expect(await findConversationBinding(db, value)).toBeUndefined();
    await expect(bindConversation(db, value, "home")).rejects.toThrow();
    expect((await pgdb.query("SELECT * FROM channel_conversation_bindings")).rows).toEqual([]);
  });

  it.each(["team", "org", "different-user"])("rejects a session owned by %s", async (owner) => {
    await pgdb.query("UPDATE agent_sessions SET owner_type = $1, owner_id = $2", [
      owner === "different-user" ? "user" : owner, "someone-else",
    ]);
    await expect(bindConversation(db, scope, "home")).rejects.toThrow();
    expect(await findConversationBinding(db, scope)).toBeUndefined();
  });

  it("rejects missing threads and threads from another session", async () => {
    await seedThread("foreign", "another-session");
    for (const id of ["missing", "foreign"]) await expect(bindConversation(db, scope, id)).rejects.toThrow();
    expect(await findConversationBinding(db, scope)).toBeUndefined();
  });

  it("retains a stored mapping when its engine thread is deleted", async () => {
    await bindConversation(db, scope, "home");
    await pgdb.query("DELETE FROM engine_threads WHERE id = 'home'");
    expect(await findConversationBinding(db, scope)).toBe("home");
    expect(await bindConversation(db, scope, "native")).toBe("home");
  });

  it("hides stored mappings after the session owner changes", async () => {
    await bindConversation(db, scope, "home");
    await pgdb.query("UPDATE agent_sessions SET owner_id = 'another-user'");
    expect(await findConversationBinding(db, scope)).toBeUndefined();
  });
});

describe("legacy Home submissions", () => {
  it.each([
    "prompt", "secret prompt", "", "{broken", '"unterminated',
    '{"kind":"signal","origin":{"channelType":"slack","threadKey":"slack:D1:111.1"},"body":"\\ud800"}',
  ])("accepts legacy TEXT %j in queue and entry columns without treating it as provenance", async value => {
    await rawQueueItem(value, value);
    await pgdb.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, signal, channel, created_at)
      VALUES ('legacy-text', $1, 'home', 'message', $2, $2, 1)`, [scope.sessionId, value]);
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(false);
    expect(await bindConversation(db, scope, "native")).toBe("native");
    expect(await findConversationBinding(db, scope)).toBe("native");
  });

  it("keeps plaintext command content when an explicit channel mark proves the Home conversation", async () => {
    await rawQueueItem("secret prompt", JSON.stringify({ channelType: "slack", channelId: scope.conversationKey }));
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
  });

  it.each(["queue channel", "queue origin", "entry channel", "entry origin"])("accepts escaped NUL in unrelated work and finds %s provenance", async source => {
    await queueItem({ content: "non-Slack work with\0NUL", channel: { channelType: "telegram", channelId: "other" } });
    await queueItem({ content: { kind: "signal", signalType: "github.comment", body: "unrelated\0signal", origin: { channelType: "github", threadKey: "github:other" } } });
    await entry({ signalType: "github.comment", attributes: { detail: "unrelated\0entry" }, origin: { channelType: "github", threadKey: "github:other" } });
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(false);
    if (source === "queue channel") {
      await queueItem({ content: "DM with\0NUL", channel: { channelType: "slack", channelId: scope.conversationKey } });
    } else if (source === "queue origin") {
      await queueItem({ content: { kind: "signal", signalType: "slack.message", body: "DM with\0NUL", origin } });
    } else if (source === "entry channel") {
      await pgdb.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, channel, created_at)
        VALUES ('nul-command', $1, 'home', 'command_result', $2, 1)`,
      [scope.sessionId, JSON.stringify({ channelType: "slack", channelId: scope.conversationKey, detail: "command\0detail" })]);
    } else {
      await entry({ signalType: "slack.message", attributes: { detail: "DM with\0NUL" }, origin });
    }
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
    expect(await bindConversation(db, scope, "home")).toBe("home");
    expect(await findConversationBinding(db, scope)).toBe("home");
  });

  it("preserves a legacy personal session whose owner ID uses the stored user ID", async () => {
    await pgdb.query("UPDATE agent_sessions SET owner_id = '' WHERE id = $1", [scope.sessionId]);
    await queueItem({ content: { kind: "signal", signalType: "slack.message", body: "Earlier message", origin: { channelType: "slack", threadKey } } });
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
    expect(await bindConversation(db, scope, "home")).toBe("home");
    expect(await findConversationBinding(db, scope)).toBe("home");
    expect(await findConversationBinding(db, { ...scope, userId: "another-user" })).toBeUndefined();
  });

  it("uses the personal owner when an older session recorded another acting user", async () => {
    await pgdb.query("UPDATE agent_sessions SET user_id = 'previous-actor' WHERE id = $1", [scope.sessionId]);
    expect(await bindConversation(db, scope, "home")).toBe("home");
    expect(await findConversationBinding(db, scope)).toBe("home");
    expect(await findConversationBinding(db, { ...scope, userId: "previous-actor" })).toBeUndefined();
    await expect(bindConversation(db, { ...scope, userId: "previous-actor" }, "home")).rejects.toThrow();
  });

  it.each(["queued", "settled", "cancelled"])("finds a %s command by its channel mark without a signal", async (status) => {
    await queueItem({ status, channel: { channelType: "slack", channelId: scope.conversationKey } });
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
  });

  it("finds queued signals without messageTs or a channel mark", async () => {
    await queueItem({ content: { kind: "signal", signalType: "slack.message", body: "before an edit", origin } });
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
  });

  it("finds recordOnly entry signals when no queue item remains", async () => {
    await entry({ signalType: "slack.message", origin });
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
  });

  it("finds command-only Home conversations by an entry channel mark without a queue item", async () => {
    await pgdb.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, channel, created_at)
      VALUES ('command', $1, 'home', 'command_result', $2, 1)`,
    [scope.sessionId, JSON.stringify({ channelType: "slack", channelId: scope.conversationKey })]);
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
    expect(await hasLegacyHomeConversation(db, { ...scope, conversationKey: "D1:222.2" }, "home", "slack:D1:222.2")).toBe(false);
    expect(await hasLegacyHomeConversation(db, { ...scope, orgId: "org-2" }, "home", threadKey)).toBe(false);
    expect(await hasLegacyHomeConversation(db, scope, "native", threadKey)).toBe(false);
  });

  it("does not use old text, message timestamps, or unrelated origins", async () => {
    await queueItem({ content: { kind: "signal", body: threadKey, origin: { ...origin, threadKey: "slack:D1:222.2" } } });
    await queueItem({ channel: { channelType: "telegram", channelId: scope.conversationKey } });
    await queueItem({ content: { kind: "signal", origin: { ...origin, channelType: "telegram" } } });
    await queueItem({ content: { kind: "signal", origin }, threadId: "native" });
    await queueItem({ content: { kind: "signal", origin }, sessionId: "another-session" });
    await queueItem({ content: { text: "ordinary prompt", origin } });
    await entry(null, scope.sessionId, "home", threadKey);
    await entry({ origin }, scope.sessionId, "native");
    await entry({ origin }, "another-session");
    await entry({ origin: { ...origin, channelType: "telegram" } });
    await entry({ origin: { ...origin, threadKey: "slack:D1:222.2" } });
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(false);
  });

  it("requires the trusted org, user owner, and engine thread session for every source", async () => {
    await queueItem({ channel: { channelType: "slack", channelId: scope.conversationKey } });
    await queueItem({ content: { kind: "signal", signalType: "slack.message", origin } });
    await entry({ origin });
    for (const value of [{ ...scope, orgId: "org-2" }, { ...scope, userId: "user-2" }]) {
      expect(await hasLegacyHomeConversation(db, value, "home", threadKey)).toBe(false);
    }
    await pgdb.query("UPDATE engine_threads SET session_id = 'another-session' WHERE id = 'home'");
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(false);
    await pgdb.query("UPDATE engine_threads SET session_id = $1 WHERE id = 'home'", [scope.sessionId]);
    await pgdb.query("UPDATE agent_sessions SET owner_type = 'team'");
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(false);
  });
});

describe("conversation binding migrations", () => {
  it("creates the scoped primary key and timestamp and reuses the engine lookup indexes", async () => {
    expect((await pgdb.query(`SELECT column_name FROM information_schema.key_column_usage
      WHERE table_name = 'channel_conversation_bindings' ORDER BY ordinal_position`)).rows)
      .toEqual(["org_id", "user_id", "session_id", "channel_type", "conversation_key"].map(column_name => ({ column_name })));
    await bindConversation(db, scope, "home");
    const row = (await pgdb.query("SELECT created_at FROM channel_conversation_bindings")).rows[0];
    expect(Number(row?.created_at)).toBeGreaterThan(0);
    const present = await pgdb.query("SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname", [indexes]);
    expect(present.rows).toEqual([...indexes].sort().map(indexname => ({ indexname })));
    expect(await missingSchemaRepairs(pgdb)).toEqual([]);
  });

  it("repairs an already applied migration and preserves bindings on subsequent boots", async () => {
    await rawQueueItem("secret prompt");
    await queueItem({ content: "non-Slack work with\0NUL" });
    await queueItem({ channel: { channelType: "slack", channelId: scope.conversationKey } });
    await queueItem({ content: { kind: "signal", signalType: "slack.message", origin } });
    await entry({ signalType: "slack.message", origin });
    const engineIndexes = await pgdb.query("SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname", [indexes]);
    await pgdb.query("DROP TABLE channel_conversation_bindings");
    expect((await missingSchemaRepairs(pgdb)).length).toBe(1);
    await applyAppMigrations(pgdb);
    expect(await missingSchemaRepairs(pgdb)).toEqual([]);
    expect((await pgdb.query("SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname", [indexes])).rows)
      .toEqual(engineIndexes.rows);
    await bindConversation(db, scope, "home");
    await applyAppMigrations(pgdb);
    expect(await findConversationBinding(db, scope)).toBe("home");
    expect(await hasLegacyHomeConversation(db, scope, "home", threadKey)).toBe(true);
    expect((await pgdb.query("SELECT count(*)::integer AS count FROM engine_queue_items")).rows).toEqual([{ count: 4 }]);
    expect((await pgdb.query("SELECT count(*)::integer AS count FROM engine_entries")).rows).toEqual([{ count: 1 }]);
  });

  it("uses session and thread indexes to bound each provenance lookup", async () => {
    const safeJson = (column: string) => `(CASE WHEN pg_input_is_valid(replace(${column}, chr(92)||'u0000', chr(92)||'uFFFD'), 'jsonb')
      THEN replace(${column}, chr(92)||'u0000', chr(92)||'uFFFD')::jsonb END)`;
    const lookups = [
      { index: "engine_queue_items_thread", table: "engine_queue_items", predicate: `${safeJson("channel")} ->> 'channelType' = 'slack' AND ${safeJson("channel")} ->> 'channelId' = 'D1:111.1'` },
      { index: "engine_queue_items_thread", table: "engine_queue_items", predicate: `${safeJson("content")} ->> 'kind' = 'signal' AND ${safeJson("content")} -> 'origin' ->> 'channelType' = 'slack' AND ${safeJson("content")} -> 'origin' ->> 'threadKey' = 'slack:D1:111.1'` },
      { index: "engine_entries_thread", table: "engine_entries", predicate: `${safeJson("channel")} ->> 'channelType' = 'slack' AND ${safeJson("channel")} ->> 'channelId' = 'D1:111.1'` },
      { index: "engine_entries_thread", table: "engine_entries", predicate: `${safeJson("signal")} -> 'origin' ->> 'channelType' = 'slack' AND ${safeJson("signal")} -> 'origin' ->> 'threadKey' = 'slack:D1:111.1'` },
    ];
    await pgdb.transaction(async tx => {
      await tx.query("SET LOCAL enable_seqscan = off");
      for (const lookup of lookups) {
        const plan = await tx.query(`EXPLAIN SELECT 1 FROM ${lookup.table}
          WHERE session_id = 'session-1' AND thread_id = 'home' AND ${lookup.predicate} LIMIT 1`);
        const text = JSON.stringify(plan.rows);
        expect(text).toContain(lookup.index);
        expect(text).toContain("Index Cond:");
        expect(text).toContain("session_id = 'session-1'");
        expect(text).toContain("thread_id = 'home'");
        expect(text).not.toContain("Seq Scan");
      }
    });
  });
});
