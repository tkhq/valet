import { InMemorySessionStore, type NormalizedEvent, type Wakeup } from "@valet/engine";
import slackPlugin from "@valet/plugin-slack/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventReceipts, eventSubscriptions } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { __resetIngestDropThrottle, ingestEvent, type IngestDeps, type IngestResult } from "./ingest.js";
import { sanitizeReceiptStages } from "./receipts.js";
import type { WaiterMatchDeps } from "./waiters.js";

const ORG = "acme";
const THREAD_SUBJECT = "slack:T001/C001/1712345678.000100";

function message(dedupeKey: string, text = "Looks good, ship it"): NormalizedEvent {
  return {
    key: "slack.message", dedupeKey, occurredAt: "2026-10-15T00:00:00.000Z",
    refs: { channel: "C001" }, summary: "U002 replied",
    payload: { type: "message", channel: "C001", user: "U002", text, thread_ts: "1712345678.000100" },
    actor: { externalId: "U002", bot: false },
    subjects: ["slack:T001", "slack:T001/C001", THREAD_SUBJECT],
  };
}

function waiter(): Wakeup {
  return {
    id: "wk_1", sessionId: "s-1", threadId: "t-1", kind: "event", status: "running", reason: "Incident",
    logOffset: 0, logTail: "", eventCount: 0, createdAt: 1, updatedAt: 1, deadlineAt: 10_000_000,
    subjects: ["slack:T001/C001"],
    eventMatch: { clauses: [{ key: "slack.message", bots: false }], once: false, self: [] },
    eventBuffer: [],
  };
}

describe("ingestEvent event waiter matching", () => {
  let db: TestPgDb;
  let store: InMemorySessionStore;
  let nudge: ReturnType<typeof vi.fn<() => void>>;
  let failed: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    db = await freshTestPgDb();
    __resetIngestDropThrottle();
    store = new InMemorySessionStore();
    await store.createWakeup(waiter());
    nudge = vi.fn<() => void>();
    failed = vi.fn<() => void>();
  });

  function waiterDeps(over: Partial<WaiterMatchDeps> = {}): WaiterMatchDeps {
    return {
      engineStore: store,
      sessionOrg: async (id) => (id === "s-1" ? { orgId: ORG, ownerType: "team", ownerId: "team-1" } : null),
      plugins: [slackPlugin],
      slackStillVisible: async () => true,
      resolvePreviousStatus: async () => null,
      nudge,
      now: () => 5_000,
      slackBotUserId: async () => "U-BOT",
      // Ingest replaces this with a check over the subscriptions it loaded.
      appMentionCovered: async () => {
        throw new Error("ingest must evaluate app_mention coverage from its loaded subscriptions");
      },
      metrics: { matched: vi.fn(), failed },
      ...over,
    };
  }

  function ingest(event: NormalizedEvent, waiters?: WaiterMatchDeps): Promise<IngestResult> {
    const deps: IngestDeps = { db: db.appDb, plugins: [slackPlugin], ...(waiters ? { waiters } : {}) };
    return ingestEvent(deps, { orgId: ORG, service: "slack", event });
  }

  async function stagesOf(): Promise<Array<{ stage: string; outcome: string; detail: string }>> {
    const [receipt] = await db.appDb.select().from(eventReceipts);
    return sanitizeReceiptStages(receipt?.stages).map((s) => ({ stage: s.stage, outcome: s.outcome, detail: s.detail }));
  }

  async function subscribeAppMention(): Promise<void> {
    await db.appDb.insert(eventSubscriptions).values({
      id: "mention-sub", orgId: ORG, ownerType: "team", ownerId: "team-1", createdBy: "u-001",
      name: "Team mentions", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C001" }],
      target: { kind: "orchestrator" }, enabled: true, createdAt: 1, updatedAt: 1,
    });
  }

  it("matches a waiter for an event no subscription matched, and records the stage", async () => {
    const result = await ingest(message("Ev-1"), waiterDeps());
    expect(result).toMatchObject({ skipped: true, deliveries: 0 });
    expect((await store.getWakeup("wk_1"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["Ev-1"]);
    expect(nudge).toHaveBeenCalledTimes(1);
    const stages = await stagesOf();
    expect(stages).toContainEqual({ stage: "waiter_match", outcome: "matched", detail: "1 event waiter matched." });
    // The waiter stage holds metadata only.
    expect(JSON.stringify(stages)).not.toContain("Looks good");
  });

  it("succeeds when the waiter's session is gone", async () => {
    const result = await ingest(message("Ev-1"), waiterDeps({ sessionOrg: async () => null }));
    expect(result).toMatchObject({ skipped: true });
    expect((await store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
    expect(await stagesOf()).toContainEqual({ stage: "waiter_match", outcome: "none", detail: "0 event waiters matched." });
    expect(nudge).not.toHaveBeenCalled();
  });

  it("appends a redelivered event once", async () => {
    await ingest(message("Ev-1"), waiterDeps());
    await ingest(message("Ev-1"), waiterDeps());
    expect((await store.getWakeup("wk_1"))?.eventBuffer).toHaveLength(1);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it("keeps the subscription outcome and receipt stages when the matcher throws (INV-E2)", async () => {
    const baseline = await ingest(message("Ev-1"));
    const baselineStages = await stagesOf();
    db = await freshTestPgDb();
    __resetIngestDropThrottle();
    const broken = new InMemorySessionStore();
    vi.spyOn(broken, "findEventWaiters").mockRejectedValue(new Error("store down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await ingest(message("Ev-1"), waiterDeps({ engineStore: broken }));
    expect({ ...result, eventId: "" }).toEqual({ ...baseline, eventId: "" });
    expect(await stagesOf()).toEqual(baselineStages);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("keeps the delivery path when the matcher throws for a matched subscription (INV-E2)", async () => {
    await db.appDb.insert(eventSubscriptions).values({
      id: "msg-sub", orgId: ORG, ownerType: "user", ownerId: "u-001", createdBy: "u-001",
      name: "Messages", eventKeys: ["slack.message"], filters: [],
      target: { kind: "orchestrator" }, enabled: true, createdAt: 1, updatedAt: 1,
    });
    const broken = new InMemorySessionStore();
    vi.spyOn(broken, "findEventWaiters").mockRejectedValue(new Error("store down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await ingest(message("Ev-1"), waiterDeps({ engineStore: broken }));
    expect(result).toMatchObject({ duplicate: false, deliveries: 1 });
    expect((await stagesOf()).map((s) => s.stage)).not.toContain("waiter_match");
    expect(failed).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("skips a bot mention that an enabled app_mention subscription covers (mention rule)", async () => {
    await subscribeAppMention();
    await ingest(message("Ev-m1", "<@U-BOT> status?"), waiterDeps());
    expect((await store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
  });

  it("matches a bot mention when no app_mention subscription covers the channel", async () => {
    await ingest(message("Ev-m2", "<@U-BOT> status?"), waiterDeps());
    expect((await store.getWakeup("wk_1"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["Ev-m2"]);
  });

  it("matches a bot mention in a channel the app_mention subscription does not cover", async () => {
    await subscribeAppMention();
    const elsewhere = message("Ev-m3", "<@U-BOT> status?");
    elsewhere.payload = { type: "message", channel: "C002", user: "U002", text: "<@U-BOT> status?" };
    elsewhere.refs = { channel: "C002" };
    elsewhere.subjects = ["slack:T001", "slack:T001/C002"];
    await store.createWakeup({ ...waiter(), id: "wk_c2", subjects: ["slack:T001/C002"], createdAt: 2 });
    await ingest(elsewhere, waiterDeps());
    expect((await store.getWakeup("wk_c2"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["Ev-m3"]);
  });
});
