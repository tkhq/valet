import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { createAssistant, loadAssistant } from "../assistants/service.js";
import { eventDropLog } from "../schema/index.js";
import { deliverToAssistantThread } from "./assistant-delivery.js";

const ORG = "org-1";
const USER = "user-1";
const OWNER = { type: "org" as const, id: ORG };

/** Wait for the first user message the delivery submitted to land on the thread. */
async function firstUserEntry(
  deps: { db: TestPgDb["appDb"]; engineHost: EngineHost },
  threadKey: string,
): Promise<MessageEntry | undefined> {
  const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
  const threadId = session.thread(threadKey).id;
  for (let i = 0; i < 100; i++) {
    const entries = await session.providers.store.getEntries(session.id, threadId);
    const entry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry | undefined;
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

describe("deliverToAssistantThread — thread-context hydration", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)"), fauxAssistantMessage("(noted)")]);
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

  const channelSignal = (body: string) => ({
    kind: "signal" as const,
    signalType: "app_mention",
    body,
    attributes: {},
    origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" as const },
  });

  it("prepends the fetched thread transcript on the first turn in a channel thread", async () => {
    const fetchThreadContext = vi.fn(async () => "Brian: kicking this off\nConner: this needs a skill");
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost, fetchThreadContext },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        threadKey: "slack:C1:1.2",
        signal: channelSignal("file an issue for this"),
        dispatchId: "d1",
        mismatchReason: "event_target_mismatch",
      },
    );

    const entry = await firstUserEntry({ db: testDb.appDb, engineHost }, "slack:C1:1.2");
    expect(fetchThreadContext).toHaveBeenCalledOnce();
    expect(entry?.content).toBe(
      "Conversation so far in this thread:\n" +
        "Brian: kicking this off\nConner: this needs a skill\n\n---\n\n" +
        "file an issue for this",
    );
  });

  it("does not fetch or prepend when the thread already has entries", async () => {
    // Seed the thread with a first delivery (no hook), then deliver again with a hook.
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        threadKey: "slack:C1:1.2",
        signal: channelSignal("first"),
        dispatchId: "d1",
        mismatchReason: "event_target_mismatch",
      },
    );
    await firstUserEntry({ db: testDb.appDb, engineHost }, "slack:C1:1.2");

    const fetchThreadContext = vi.fn(async () => "should not be used");
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost, fetchThreadContext },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        threadKey: "slack:C1:1.2",
        signal: channelSignal("second"),
        dispatchId: "d2",
        mismatchReason: "event_target_mismatch",
      },
    );
    expect(fetchThreadContext).not.toHaveBeenCalled();
  });

  it("two racing deliveries on one new thread seed the transcript exactly once (TKAI-284)", async () => {
    // A slow transcript fetch is the race window: without per-thread
    // serialization, both deliveries pass the empty-thread check during the
    // other's fetch and both prepend.
    const fetchThreadContext = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "Brian: earlier context";
    });
    await Promise.all([
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost, fetchThreadContext },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          threadKey: "slack:C1:1.2",
          signal: channelSignal("mention one"),
          dispatchId: "d1",
          mismatchReason: "event_target_mismatch",
        },
      ),
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost, fetchThreadContext },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          threadKey: "slack:C1:1.2",
          signal: channelSignal("mention two"),
          dispatchId: "d2",
          mismatchReason: "event_target_mismatch",
        },
      ),
    ]);
    expect(fetchThreadContext).toHaveBeenCalledOnce();

    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, OWNER, {
      actorUserId: USER,
      orgId: ORG,
    });
    const threadId = session.thread("slack:C1:1.2").id;
    let seeded: string[] = [];
    for (let i = 0; i < 100; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      const userBodies = entries
        .filter((e): e is MessageEntry => e.type === "message" && e.role === "user")
        .map((e) => e.content ?? "");
      if (userBodies.length >= 2) {
        seeded = userBodies.filter((b) => b.includes("Conversation so far in this thread:"));
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seeded).toHaveLength(1);
  });
});

describe("deliverToAssistantThread — which assistant answers", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)"), fauxAssistantMessage("(noted)")]);
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

  const signal = (body: string) => ({
    kind: "signal" as const,
    signalType: "app_mention",
    body,
    attributes: {},
  });

  /** A second, non-default assistant for `OWNER`. The first call for a
   * principal takes the default slot, so seed that one first. */
  async function secondAssistant(): Promise<string> {
    await createAssistant(testDb.appDb, ORG, OWNER, "Primary");
    const created = await createAssistant(testDb.appDb, ORG, OWNER, "Ops");
    return created.id;
  }

  it("routes to the NAMED assistant, not the owner's default", async () => {
    const assistantId = await secondAssistant();
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        threadKey: "events",
        signal: signal("go"),
        dispatchId: "d1",
        assistantId,
        mismatchReason: "event_target_mismatch",
      },
    );

    // The named assistant's own session holds it...
    const row = await loadAssistant(testDb.appDb, assistantId);
    const named = await engineHost.assistantSessionFor(
      assistantId,
      { actorUserId: USER, orgId: ORG },
      { sessionId: row!.sessionId },
    );
    const namedThread = named.thread("events").id;
    let landed: string | undefined;
    for (let i = 0; i < 100; i++) {
      const entries = await named.providers.store.getEntries(named.id, namedThread);
      const entry = entries.find((e) => e.type === "message" && e.role === "user") as
        | MessageEntry
        | undefined;
      if (entry) {
        landed = entry.content ?? "";
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(landed).toBe("go");

    // ...and the default's does NOT. Without the routing, this is where it went.
    const fallback = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, OWNER, {
      actorUserId: USER,
      orgId: ORG,
    });
    const defaultEntries = await fallback.providers.store.getEntries(
      fallback.id,
      fallback.thread("events").id,
    );
    expect(defaultEntries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(0);
  });

  it("refuses an assistant that does not exist, and drop-logs it", async () => {
    await expect(
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          threadKey: "events",
          signal: signal("go"),
          dispatchId: "d-missing",
          assistantId: "no-such-assistant",
          mismatchReason: "event_target_mismatch",
        },
      ),
    ).rejects.toThrow(/no such assistant/);

    const drops = await testDb.appDb.select().from(eventDropLog);
    expect(drops.map((d) => d.reason)).toContain("event_target_assistant_invalid");
  });

  it("refuses an assistant owned by a different principal", async () => {
    // Live and in-org, but owned by a user rather than by the delivery's org.
    const other = await createAssistant(testDb.appDb, ORG, { type: "user", id: USER }, "Someone else's");
    await expect(
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          threadKey: "events",
          signal: signal("go"),
          dispatchId: "d-foreign",
          assistantId: other.id,
          mismatchReason: "event_target_mismatch",
        },
      ),
    ).rejects.toThrow(/owned by user:/);
  });
});
