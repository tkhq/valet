import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { findFollowedThread, upsertFollowedThread } from "../events/followed-threads.js";
import { handleFollowedMessage, slackMessageFields } from "./follow-router.js";

const ORG = "org-1";
const USER = "user-1";

function envelope(event: Record<string, unknown>, eventId = "Ev1"): Record<string, unknown> {
  return { type: "event_callback", event_id: eventId, team_id: "T1", event };
}

describe("slackMessageFields", () => {
  const good = envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.5", user: "U9", text: "hey" });

  it("parses a threaded human message", () => {
    expect(slackMessageFields(good)).toEqual({
      channel: "C1",
      threadTs: "1.2",
      ts: "1.5",
      user: "U9",
      text: "hey",
      eventId: "Ev1",
    });
  });

  it("drops a top-level message (no thread_ts)", () => {
    expect(slackMessageFields(envelope({ type: "message", channel: "C1", ts: "1.5", text: "x" }))).toBeNull();
  });

  it("drops the bot's own posts and noise subtypes", () => {
    expect(slackMessageFields(envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.6", bot_id: "B1", text: "x" }))).toBeNull();
    expect(slackMessageFields(envelope({ type: "message", subtype: "message_changed", channel: "C1", thread_ts: "1.2", ts: "1.6", text: "x" }))).toBeNull();
  });

  it("drops non-message events and malformed envelopes", () => {
    expect(slackMessageFields(envelope({ type: "app_mention", channel: "C1", thread_ts: "1.2", ts: "1.6" }))).toBeNull();
    expect(slackMessageFields({ event: { type: "message" } })).toBeNull();
    expect(slackMessageFields(null)).toBeNull();
  });
});

describe("handleFollowedMessage", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)")]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    engineHost = new EngineHost({
      engineStore: new PgSessionStore(pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb),
      engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
    });
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  it("routes a followed threaded message to the bound assistant thread as an overheard signal", async () => {
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "1.2",
      ownerType: "org",
      ownerId: ORG,
      createdBy: USER,
    });

    await handleFollowedMessage(
      { db: testDb.appDb, engineHost },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "any update?" }) },
    );

    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const threadId = session.thread("slack:C1:1.2").id;
    let userEntry: MessageEntry | undefined;
    for (let i = 0; i < 100; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      userEntry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry | undefined;
      if (userEntry) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(userEntry?.content).toBe("any update?");
    expect(userEntry?.signal?.origin).toEqual({
      channelType: "slack",
      threadKey: "slack:C1:1.2",
      reply: "manual",
      messageTs: "1.7",
    });
  });

  it("prepends the missed window and advances last_seen_ts", async () => {
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "1.2",
      ownerType: "org",
      ownerId: ORG,
      createdBy: USER,
      lastSeenTs: "1.3",
    });

    const windowCalls: { afterTs: string; beforeTs: string }[] = [];
    await handleFollowedMessage(
      {
        db: testDb.appDb,
        engineHost,
        fetchThreadWindow: async (_service, args) => {
          windowCalls.push({ afterTs: args.afterTs, beforeTs: args.beforeTs });
          return "workflow-bot: deploy finished";
        },
      },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "any update?" }) },
    );

    expect(windowCalls).toEqual([{ afterTs: "1.3", beforeTs: "1.7" }]);
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const threadId = session.thread("slack:C1:1.2").id;
    let userEntry: MessageEntry | undefined;
    for (let i = 0; i < 100; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      userEntry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry | undefined;
      if (userEntry) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(userEntry?.content).toBe(
      "Messages in this thread since you last saw it:\nworkflow-bot: deploy finished\n\n---\n\nany update?",
    );
    const row = await findFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "1.2",
    });
    expect(row?.lastSeenTs).toBe("1.7");
  });

  it("delivers the bare message when the window is empty, and skips the fetch with no last_seen_ts", async () => {
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "2.2",
      ownerType: "org",
      ownerId: ORG,
      createdBy: USER,
      // No lastSeenTs: a pre-column row. The fetch must not run.
    });
    let called = 0;
    await handleFollowedMessage(
      {
        db: testDb.appDb,
        engineHost,
        fetchThreadWindow: async () => {
          called += 1;
          return null;
        },
      },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "2.2", ts: "2.5", user: "U9", text: "first" }, "Ev2") },
    );
    expect(called).toBe(0);
    const session0 = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    // Wait for the first delivery's entry before the second, so the two
    // overheard signals cannot coalesce into a digest (TKAI-297) and each
    // writes its own user entry.
    const threadId0 = session0.thread("slack:C1:2.2").id;
    for (let i = 0; i < 100; i++) {
      const entries = await session0.providers.store.getEntries(session0.id, threadId0);
      if (entries.some((e) => e.type === "message" && e.role === "user")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Tracking starts at this delivery; the next gap fetch runs but an empty
    // window (null) delivers the bare message.
    await handleFollowedMessage(
      {
        db: testDb.appDb,
        engineHost,
        fetchThreadWindow: async () => {
          called += 1;
          return null;
        },
      },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "2.2", ts: "2.9", user: "U9", text: "second" }, "Ev3") },
    );
    expect(called).toBe(1);
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const threadId = session.thread("slack:C1:2.2").id;
    let entries: Awaited<ReturnType<typeof session.providers.store.getEntries>> = [];
    for (let i = 0; i < 100; i++) {
      entries = await session.providers.store.getEntries(session.id, threadId);
      if (entries.filter((e) => e.type === "message" && e.role === "user").length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const bodies = entries
      .filter((e): e is MessageEntry => e.type === "message" && e.role === "user")
      .map((e) => e.content);
    expect(bodies).toContain("second");
    expect(bodies.some((b) => typeof b === "string" && b.includes("since you last saw it"))).toBe(false);
  });

  it("ignores a message on an unfollowed thread (no delivery)", async () => {
    await handleFollowedMessage(
      { db: testDb.appDb, engineHost },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "9.9", ts: "9.9", user: "U9", text: "hi" }) },
    );
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const entries = await session.providers.store.getEntries(session.id, session.thread("slack:C1:9.9").id);
    expect(entries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(0);
  });
});
