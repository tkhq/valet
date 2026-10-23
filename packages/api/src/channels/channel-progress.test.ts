import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelProgressRejectedError, InMemoryEventStream } from "@valet/engine";
import { PgSessionStore } from "@valet/store-postgres";
import { channelProgressDeliveries as deliveries } from "../schema/index.js";
import { applyAppMigrations, missingSchemaRepairs } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { CHANNEL_PROGRESS_MAX_ATTEMPTS, ChannelProgressPublisher, type ProgressTransport } from "./channel-progress.js";

async function setup() {
  const { pgdb, appDb } = await freshTestPgDb();
  const store = new PgSessionStore(pgdb);
  await pgdb.query(`INSERT INTO engine_sessions
    (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
    VALUES ('s', 'user', 'u', 'u', 'org', 'w', 'assistant', 'active', 0, 0),
      ('foreign', 'user', 'u', 'u', 'another-org', 'w', 'assistant', 'active', 0, 0)`);
  await store.saveThread("s", { id: "t", sessionId: "s", key: "events", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
  let now = 1_000;
  const publish = vi.fn<NonNullable<ProgressTransport["publishProgress"]>>(async () => ({ messageId: "native-1" }));
  const transport: ProgressTransport = { publishProgress: publish, conversationKeyFromThreadKey: key => `fake:workspace:${key}`, threadKeyFromConversationKey: key => key };
  const events = new InMemoryEventStream();
  const make = () => new ChannelProgressPublisher({ db: appDb, engineStore: store, eventStream: events,
    resolveOrgId: async () => "org", transportFor: type => type === "fake" ? transport : undefined, now: () => now });
  async function seed(id = "q", content: unknown = "hello", session = "s", channel: unknown = { channelType: "fake", channelId: "fake:workspace:room", threadId: "native-thread" }) {
    await pgdb.query(`INSERT INTO engine_queue_items
      (id, session_id, thread_id, status, content, channel, attempt_count, max_attempts, timeout_at, created_at, updated_at)
      VALUES ($1, $2, 't', 'running', $3, $4, 0, 10, 99999999, 0, 0)`,
    [id, session, JSON.stringify(content), channel === null ? null : JSON.stringify(channel)]);
  }
  return { pgdb, appDb, store, publish, transport, events, make, seed,
    advance: (ms = 120_000) => { now += ms; }, rows: () => appDb.select().from(deliveries) };
}
let f: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { f = await setup(); });

const signal = (reply?: "manual" | "auto") => ({ kind: "signal", signalType: "fake.message", body: "overheard", origin: { channelType: "fake", threadKey: "fake:room:root", ...(reply ? { reply } : {}) } });

async function reply(turnId: string, toolId: string, ok: boolean, status: "completed" | "running" = "completed") {
  await f.store.appendEntries("s", "t", [{ type: "message", id: `entry-${turnId}-${toolId}-${ok}-${status}`, sessionId: "s", threadId: "t", parentId: null,
    createdAt: 1, role: "assistant", content: "", queueItemId: turnId,
    parts: [{ type: "tool_call", callId: "call", toolName: "call_tool", status, args: { tool_id: toolId }, result: { details: { ok } } }] }]);
}

describe("channel progress durable publisher", () => {
  it("repairs the ledger and indexes in a pre-1.0 database", async () => {
    await f.pgdb.query("DROP TABLE channel_progress_deliveries");
    await applyAppMigrations(f.pgdb);
    await f.seed();
    await f.make().poll();
    expect((await f.rows())[0].messageId).toBe("native-1");
    const pending = await missingSchemaRepairs(f.pgdb);
    expect(pending.filter(repair => repair.describe.startsWith("channel progress"))).toEqual([]);
  });

  it("commits intent and uncertainty marker before create, then updates the same message after restart", async () => {
    await f.seed();
    f.publish.mockImplementation(async () => {
      const [row] = await f.rows();
      expect(row.createStarted).toBe(true);
      expect(row.leaseToken).toBeTruthy();
      return { messageId: "native-1" };
    });
    await f.make().poll();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0][2]).toMatchObject({ threadTs: "native-thread" });
    const [created] = await f.rows();
    expect(created.messageId).toBe("native-1");
    expect(created.lastRevision).toBeTruthy();
    await f.pgdb.query("UPDATE engine_queue_items SET status='settled', outcome='completed', updated_at=10 WHERE id='q'");
    f.advance();
    await f.make().poll();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[1][2]).toMatchObject({ messageId: "native-1", idempotencyKey: created.id });
    expect(f.publish.mock.calls[1][1].status).toBe("complete");
    expect((await f.rows())[0].completedAt).toBeTruthy();
    f.advance();
    await f.make().poll();
    expect(f.publish).toHaveBeenCalledTimes(2);
  });

  it("coalesces bursts and stale events against the current durable snapshot", async () => {
    await f.seed();
    const publisher = f.make();
    for (let i = 0; i < 100; i++) publisher.observe({ sessionId: "s", queueItemId: "q", timestamp: i,
      event: { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: "q", outcome: { outcome: "failed" } } });
    await publisher.poll();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0][1].status).toBe("in_progress");
    f.advance();
    await publisher.poll();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("retries a definitively rejected first create as a create after restart", async () => {
    await f.seed();
    f.publish.mockRejectedValueOnce(new ChannelProgressRejectedError("rate_limited"));
    await f.make().poll();
    expect((await f.rows())[0]).toMatchObject({ createStarted: false, messageId: null, attempts: 1 });
    f.advance();
    await f.make().poll();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[1][2]).toMatchObject({ messageId: undefined });
    expect(f.publish.mock.calls[1][2].recoverOnly).toBeUndefined();
    expect((await f.rows())[0]).toMatchObject({ createStarted: true, messageId: "native-1", attempts: 0 });
  });

  it("keeps recovery-only mode when recovery receives a definitive rejection", async () => {
    await f.seed();
    f.publish.mockRejectedValueOnce(new Error("unknown create outcome"));
    await f.make().poll();
    f.publish.mockRejectedValueOnce(new ChannelProgressRejectedError("invalid_auth"));
    f.advance(); await f.make().poll();
    expect((await f.rows())[0]).toMatchObject({ createStarted: true, messageId: null, attempts: 2 });
    f.advance(); await f.make().poll();
    expect(f.publish.mock.calls[1][2].recoverOnly).toBe(true);
    expect(f.publish.mock.calls[2][2].recoverOnly).toBe(true);
  });

  it("does not reset creation state for a known-message rejection", async () => {
    await f.seed();
    await f.make().poll();
    await f.pgdb.query("UPDATE engine_queue_items SET updated_at=1 WHERE id='q'");
    f.publish.mockRejectedValueOnce(new ChannelProgressRejectedError("invalid_auth"));
    f.advance(); await f.make().poll();
    expect((await f.rows())[0]).toMatchObject({ createStarted: true, messageId: "native-1", attempts: 1 });
    f.advance(); await f.make().poll();
    expect(f.publish.mock.calls[2][2].messageId).toBe("native-1");
  });

  it("does not reset a rejected create after losing its lease", async () => {
    await f.seed();
    f.publish.mockImplementationOnce(async () => {
      await f.pgdb.query("UPDATE channel_progress_deliveries SET lease_token='new-owner'");
      throw new ChannelProgressRejectedError("rate_limited");
    });
    await f.make().poll();
    expect((await f.rows())[0]).toMatchObject({ createStarted: true, messageId: null, leaseToken: "new-owner" });
  });

  it("keeps uncertainty when the create rejection arrives after lease expiry", async () => {
    await f.seed();
    f.publish.mockImplementationOnce(async () => {
      f.advance();
      throw new ChannelProgressRejectedError("rate_limited");
    });
    await f.make().poll();
    expect((await f.rows())[0]).toMatchObject({ createStarted: true, messageId: null });
  });

  it("never creates again after an uncertain creation, and bounds recovery attempts", async () => {
    await f.seed();
    f.publish.mockRejectedValueOnce(new Error("connection lost after create"));
    await f.make().poll();
    f.publish.mockResolvedValue(null);
    for (let i = 1; i < CHANNEL_PROGRESS_MAX_ATTEMPTS + 2; i++) { f.advance(); await f.make().poll(); }
    expect(f.publish).toHaveBeenCalledTimes(CHANNEL_PROGRESS_MAX_ATTEMPTS);
    expect(f.publish.mock.calls.slice(1).every(call => call[2].recoverOnly === true)).toBe(true);
    const [row] = await f.rows();
    expect(row.failedAt).toBeTruthy();
    expect(row.attempts).toBe(CHANNEL_PROGRESS_MAX_ATTEMPTS);
    expect(row.messageId).toBeNull();
  });

  it("reconciles uncertain creation then updates the recovered reference", async () => {
    await f.seed();
    f.publish.mockRejectedValueOnce(new Error("lost response"));
    await f.make().poll();
    f.advance();
    await f.make().poll();
    expect(f.publish.mock.calls[1][2].recoverOnly).toBe(true);
    expect(f.publish.mock.calls[2][2].messageId).toBe("native-1");
    expect((await f.rows())[0]).toMatchObject({ attempts: 0, messageId: "native-1" });
  });

  it("retries a known message update without another create", async () => {
    await f.seed();
    await f.make().poll();
    await f.pgdb.query("UPDATE engine_queue_items SET status='settled', outcome='failed', updated_at=1 WHERE id='q'");
    f.publish.mockRejectedValueOnce(new Error("update failed"));
    f.advance(); await f.make().poll();
    expect((await f.rows())[0].completedAt).toBeNull();
    f.advance(); await f.make().poll();
    expect(f.publish.mock.calls.slice(1).every(call => call[2].messageId === "native-1" && !call[2].recoverOnly)).toBe(true);
    expect((await f.rows())[0].completedAt).toBeTruthy();
  });

  it("isolates organizations and uses the turn destination rather than a thread binding or replyTarget", async () => {
    await f.seed("foreign-q", "hello", "foreign");
    await f.seed();
    await f.pgdb.query(`UPDATE engine_queue_items SET reply_target='{"channelType":"fake","channelId":"other-destination"}' WHERE id='q'`);
    const publisher = f.make();
    await publisher.track("foreign", "foreign-q");
    await publisher.poll();
    expect((await f.rows()).map(row => row.turnId)).toEqual(["q"]);
    expect(f.publish.mock.calls[0][0]).toBe("fake:workspace:room");
    await f.pgdb.query("UPDATE engine_sessions SET org_id='another-org' WHERE id='s'");
    f.advance(); await publisher.poll();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("skips transports that do not support progress", async () => {
    await f.seed();
    f.transport.publishProgress = undefined;
    await f.make().poll();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
  });

  it("does not replay historical completed turns as new cards", async () => {
    await f.seed();
    await f.pgdb.query("UPDATE engine_queue_items SET status='settled', outcome='completed' WHERE id='q'");
    await f.make().poll();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
  });

  it("discovers unfinished work in bounded keyset pages without starvation", async () => {
    for (let i = 0; i < 51; i++) await f.seed(`q${String(i).padStart(3, "0")}`);
    const publisher = f.make();
    await publisher.recover();
    expect(await f.rows()).toHaveLength(50);
    await publisher.recover();
    expect(await f.rows()).toHaveLength(51);
    await publisher.recover();
    expect(await f.rows()).toHaveLength(51);
  });

  it("claims a cross-process lease and serializes concurrent polls", async () => {
    await f.seed();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.publish.mockImplementationOnce(async () => { await blocked; return { messageId: "native-1" }; });
    const one = f.make(), two = f.make();
    const running = one.poll();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    expect(one.poll()).toBe(running);
    await two.poll();
    expect(f.publish).toHaveBeenCalledTimes(1);
    release(); await running;
    await one.stop(); await two.stop();
  });

  it("fences a lost lease and recovers a crash-window creation", async () => {
    await f.seed();
    f.publish.mockImplementationOnce(async () => {
      await f.pgdb.query("UPDATE channel_progress_deliveries SET lease_token='new-owner', lease_until=0");
      return { messageId: "lost-owner-message" };
    });
    await f.make().poll();
    expect((await f.rows())[0]).toMatchObject({ lastRevision: null, messageId: null, createStarted: true, leaseToken: "new-owner" });
    f.advance(); await f.make().poll();
    expect(f.publish.mock.calls[1][2].recoverOnly).toBe(true);
    expect((await f.rows())[0].messageId).toBe("native-1");
  });

  it("subscribes on start, discovers live settlement, and unsubscribes on stop", async () => {
    await f.seed();
    // A settled item is discoverable only through an event or an existing intent.
    await f.pgdb.query("UPDATE engine_queue_items SET status='settled', outcome='aborted' WHERE id='q'");
    const publisher = f.make();
    publisher.start();
    await publisher.poll();
    await f.events.append({ sessionId: "s", queueItemId: "q", timestamp: 1, event: {
      type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: "q", outcome: { outcome: "aborted" },
    } }, "settled");
    await publisher.poll();
    expect(f.publish.mock.calls[0][1].status).toBe("interrupted");
    await publisher.stop();
  });
});

describe("visible work authorization", () => {
  it.each(["manual", undefined] as const)("suppresses %s signals even when they carry a channel target", async policy => {
    await f.seed("q", signal(policy));
    await f.make().poll();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("permits auto origins and uses their destination", async () => {
    await f.seed("q", signal("auto"));
    await f.make().poll();
    expect(f.publish.mock.calls[0][0]).toBe("fake:workspace:fake:room:root");
    expect(f.publish.mock.calls[0][2].threadTs).toBe("root");
  });

  it("permits a manual origin only after that turn successfully replies to that origin service", async () => {
    await f.seed("q", signal("manual"));
    await f.seed("other", signal("manual"));
    await reply("other", "fake.reply_to_origin", true);
    await reply("q", "wrong.reply_to_origin", true);
    await reply("q", "fake.post_message", true);
    await reply("q", "fake.reply_to_origin", false);
    await reply("q", "fake.reply_to_origin", true, "running");
    const publisher = f.make();
    await publisher.poll();
    expect((await f.rows()).map(row => row.turnId)).toEqual(["other"]);
    await reply("q", "fake.reply_to_origin", true);
    await publisher.track("s", "q");
    await publisher.poll();
    expect((await f.rows()).map(row => row.turnId).sort()).toEqual(["other", "q"]);
  });

  it("does not infer signal authorization from author flags without an explicit origin policy", async () => {
    await f.seed("direct", signal());
    await f.seed("manual-direct", signal("manual"));
    await f.pgdb.query(`UPDATE engine_queue_items SET author='{"id":"u","directChannel":true}'`);
    await f.make().poll();
    expect(await f.rows()).toEqual([]);
  });

  it("suppresses empty native roots for both origins and direct targets", async () => {
    await f.seed("origin", { ...signal("auto"), origin: { channelType: "fake", threadKey: "fake:room:", reply: "auto" } });
    await f.seed("direct", "hello", "s", { channelType: "fake", channelId: "fake:workspace:room:" });
    await f.make().poll();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
  });

  it("does not infer channel authorization from web replyTarget", async () => {
    await f.seed("q", "web prompt", "s", null);
    await f.pgdb.query(`UPDATE engine_queue_items SET reply_target='{"channelType":"fake","channelId":"room"}'`);
    await f.make().poll();
    expect(f.publish).not.toHaveBeenCalled();
  });
});
