import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
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
