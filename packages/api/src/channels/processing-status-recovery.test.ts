import { expect, it, vi } from "vitest";
import { InMemoryEventStream, type ChannelTransport } from "@valet/engine";
import { PgSessionStore } from "@valet/store-postgres";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { ChannelProcessingStatus } from "./processing-status.js";
import { restoreProcessingStatus, trackProcessingItem } from "./processing-status-recovery.js";

it("restores queued, running and gated Slack work from Postgres across pages and clears on settlement", async () => {
  const { pgdb, appDb } = await freshTestPgDb();
  const store = new PgSessionStore(pgdb);
  for (const [id, org] of [["s", "org"], ["foreign", "another-org"]]) {
    await pgdb.query(`INSERT INTO engine_sessions
      (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
      VALUES ($1, 'user', 'u', 'u', $2, 'w', 'assistant', 'active', 0, 0)`, [id, org]);
  }
  const channel = JSON.stringify({ channelType: "slack", channelId: "slack:T:D:123.456" });
  // More than one page, with all three live states and one already-settled row.
  await pgdb.query(`INSERT INTO engine_queue_items
    (id, session_id, thread_id, status, content, channel, attempt_count, max_attempts, timeout_at, created_at, updated_at)
    SELECT 'q' || n, 's', 't', CASE WHEN n = 102 THEN 'settled' WHEN n = 0 THEN 'blocked_on_decision_gate'
      WHEN n = 1 THEN 'running' ELSE 'queued' END, '"hello"', $1, 0, 10, 99999999, 0, 0
    FROM generate_series(0, 102) n`, [channel]);
  await pgdb.query(`INSERT INTO engine_queue_items
    (id, session_id, thread_id, status, content, channel, attempt_count, max_attempts, timeout_at, created_at, updated_at)
    VALUES ('foreign-q', 'foreign', 't', 'queued', '"hello"', $1, 0, 10, 99999999, 0, 0),
      ('telegram-q', 's', 't', 'queued', '"hello"', '{"channelType":"telegram","channelId":"telegram:dm:1"}', 0, 10, 99999999, 0, 0)`, [channel]);
  await store.saveDecisionGate("s", "t", {
    id: "g1", sessionId: "s", threadId: "t", queueItemId: "q0", resumeKey: "r1", ordinal: 0,
    type: "question", title: "Which branch?", actions: [], status: "pending", createdAt: 0, updatedAt: 0,
  });

  const calls: string[] = [];
  const transport = { setStatus: async (_key: string, _ts: string, value: string) => { calls.push(value); } };
  const first = new ChannelProcessingStatus(new InMemoryEventStream(), () => transport);
  first.start();
  await restoreProcessingStatus(appDb, store, first, "org");
  await first.stop();
  // A settled queue item must not be restored by a new process.
  await pgdb.query("UPDATE engine_queue_items SET status = 'settled' WHERE id = 'q101'");
  calls.length = 0;

  // A new owner has no registrations from the previous process.
  const events = new InMemoryEventStream();
  const second = new ChannelProcessingStatus(events, () => transport);
  second.start();
  try {
    await restoreProcessingStatus(appDb, store, second, "org");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls.at(-1)).toBe("is waiting for your response…");
    const restored = calls.length;
    expect(restored).toBe(102); // 101 submissions and the pending gate.
    for (let n = 1; n < 101; n++) {
      await events.append({ sessionId: "s", threadId: "t", timestamp: n,
        event: { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: `q${n}`, outcome: { outcome: "completed" } } }, `settled:q${n}`);
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls.at(-1)).toBe("is waiting for your response…");
    await events.append({ sessionId: "s", threadId: "t", timestamp: 200,
      event: { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: "q0", outcome: { outcome: "aborted" } } }, "settled:q0");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await vi.waitFor(() => expect(calls.at(-1)).toBe(""));
  } finally {
    await second.stop();
  }
});

it("recovers DM status past a page of non-Slack work containing escaped NUL", async () => {
  const { pgdb, appDb } = await freshTestPgDb();
  const store = new PgSessionStore(pgdb);
  await pgdb.query(`INSERT INTO engine_sessions
    (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
    VALUES ('s', 'user', 'u', 'u', 'org', 'w', 'assistant', 'active', 0, 0)`);
  await pgdb.query(`INSERT INTO engine_queue_items
    (id, session_id, thread_id, status, content, attempt_count, max_attempts, timeout_at, created_at, updated_at)
    SELECT 'a' || n, 's', 't', 'queued', $1, 0, 10, 99999999, 0, 0
    FROM generate_series(1, 100) n`, [JSON.stringify("hello\0world")]);
  await pgdb.query(`INSERT INTO engine_queue_items
    (id, session_id, thread_id, status, content, channel, attempt_count, max_attempts, timeout_at, created_at, updated_at)
    VALUES ('z', 's', 't', 'queued', $1, $2, 0, 10, 99999999, 0, 0)`,
  [JSON.stringify("DM with\0NUL"), JSON.stringify({ channelType: "slack", channelId: "slack:T:D100:123.456" })]);
  const calls: string[] = [];
  const status = new ChannelProcessingStatus(new InMemoryEventStream(), () => ({
    setStatus: async (key, _ts, value) => { calls.push(`${key} ${value}`); },
  }));
  status.start();
  try {
    await restoreProcessingStatus(appDb, store, status, "org");
    expect(calls).toEqual(["slack:T:D100:123.456 is thinking…"]);
  } finally {
    await status.stop();
  }
});

it.each(["startup", "live"])("tracks only Slack DMs from channel targets and signal origins during %s", async mode => {
  const { pgdb, appDb } = await freshTestPgDb();
  const store = new PgSessionStore(pgdb);
  await pgdb.query(`INSERT INTO engine_sessions
    (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
    VALUES ('s', 'user', 'u', 'u', 'org', 'w', 'assistant', 'active', 0, 0)`);
  const calls: string[] = [];
  const transport: ChannelTransport = {
    channelType: "slack",
    verifyWebhook: () => null,
    parseUpdate: () => null,
    send: async key => ({ conversationKey: key, messageId: "m" }),
    sendMedia: async key => ({ conversationKey: key, messageId: "m" }),
    sendGatePrompt: async key => ({ conversationKey: key, messageId: "g" }),
    updateGatePrompt: async () => {},
    conversationKeyFromThreadKey: key => `slack:T:${key.slice(6)}`,
    setStatus: async (key, _ts, value) => { calls.push(`${key} ${value}`); },
  };
  const status = new ChannelProcessingStatus(new InMemoryEventStream(), () => transport);
  status.start();
  try {
    for (const source of ["channel", "origin"]) {
      for (const channelId of ["C100", "G100", "D100"]) {
        const id = `${source}-${channelId}`;
        const ts = source === "channel" ? "123.456" : "123.457";
        const content = source === "channel" ? "hello" : {
          kind: "signal", signalType: "slack.message", body: "a passing remark in a followed thread",
          origin: { channelType: "slack", threadKey: `slack:${channelId}:${ts}`, reply: "manual" },
        };
        const channel = source === "channel" ? { channelType: "slack", channelId: `slack:T:${channelId}:${ts}` } : null;
        await pgdb.query(`INSERT INTO engine_queue_items
          (id, session_id, thread_id, status, content, channel, attempt_count, max_attempts, timeout_at, created_at, updated_at)
          VALUES ($1, 's', 't', 'queued', $2, $3, 0, 10, 99999999, 0, 0)`,
        [id, JSON.stringify(content), channel && JSON.stringify(channel)]);
        if (mode === "live") {
          const item = await store.getQueueItem("s", id);
          if (!item) throw new Error(`Missing queue item ${id}`);
          await trackProcessingItem(store, status, "s", item, transport);
        }
      }
    }
    if (mode === "startup") await restoreProcessingStatus(appDb, store, status, "org", transport);
    expect(calls).toEqual([
      "slack:T:D100:123.456 is thinking…",
      "slack:T:D100:123.457 is thinking…",
    ]);
  } finally {
    await status.stop();
  }
});
