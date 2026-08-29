import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { upsertFollowedThread } from "../events/followed-threads.js";
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
