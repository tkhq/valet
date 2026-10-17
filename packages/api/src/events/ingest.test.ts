import { InMemorySessionStore, type CredentialStore, type NormalizedEvent, type Wakeup } from "@valet/engine";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventDeliveries, eventReceipts, eventSubscriptions, orgMembers, teamMembers, teams, userIdentityLinks } from "../schema/index.js";
import type { ClaimDeps } from "./claims.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { __resetIngestDropThrottle, ingestEvent, type IngestDeps, type IngestResult } from "./ingest.js";
import { sanitizeReceiptStages } from "./receipts.js";
import { waiterMatchDeps, type WaiterMatchDeps } from "./waiters.js";

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
      metrics: { matched: vi.fn(), failed },
      ...over,
    };
  }

  function ingest(event: NormalizedEvent, waiters?: WaiterMatchDeps, claims?: Partial<ClaimDeps>): Promise<IngestResult> {
    const deps: IngestDeps = { db: db.appDb, plugins: [slackPlugin], ...(waiters ? { waiters } : {}), ...(claims ? { claims } : {}) };
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

  it("succeeds when the waiter's session is gone, and adds no stage for a waiter that is no candidate", async () => {
    const result = await ingest(message("Ev-1"), waiterDeps({ sessionOrg: async () => null }));
    expect(result).toMatchObject({ skipped: true });
    expect((await store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
    expect((await stagesOf()).map((s) => s.stage)).not.toContain("waiter_match");
    expect(nudge).not.toHaveBeenCalled();
  });

  it("adds no waiter_match stage when no running waiter shares a subject", async () => {
    const elsewhere = { ...message("Ev-9"), subjects: ["slack:T001", "slack:T001/C777"], refs: { channel: "C777" } };
    await ingest(elsewhere, waiterDeps());
    expect((await stagesOf()).map((s) => s.stage)).not.toContain("waiter_match");
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

  it("keeps the delivery path and receipt stages when the matcher throws for a matched subscription (INV-E2)", async () => {
    const subscribeMessages = () => db.appDb.insert(eventSubscriptions).values({
      id: "msg-sub", orgId: ORG, ownerType: "user", ownerId: "u-001", createdBy: "u-001",
      name: "Messages", eventKeys: ["slack.message"], filters: [],
      target: { kind: "orchestrator" }, enabled: true, createdAt: 1, updatedAt: 1,
    });
    await subscribeMessages();
    const baseline = await ingest(message("Ev-1"));
    const baselineStages = await stagesOf();
    db = await freshTestPgDb();
    __resetIngestDropThrottle();
    await subscribeMessages();
    const broken = new InMemorySessionStore();
    vi.spyOn(broken, "findEventWaiters").mockRejectedValue(new Error("store down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await ingest(message("Ev-1"), waiterDeps({ engineStore: broken }));
    expect(result).toMatchObject({ duplicate: false, deliveries: 1 });
    expect({ ...result, eventId: "" }).toEqual({ ...baseline, eventId: "" });
    expect(await stagesOf()).toEqual(baselineStages);
    expect(failed).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  describe("bounded provider calls", () => {
    const never = () => new Promise<never>(() => undefined);
    const credentials: CredentialStore = {
      get: async (_owner, service) => (service === "linear"
        ? { type: "oauth2", accessToken: "lin-app-token", metadata: { grant: "client_credentials" } }
        : null),
      save: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
      compareAndSwap: async () => false,
    };
    function boundedDeps(opts: Parameters<typeof waiterMatchDeps>[1]): WaiterMatchDeps {
      const base = waiterMatchDeps({ db: db.appDb, engineStore: store, engineCredentials: credentials, plugins: [slackPlugin, linearPlugin] }, opts);
      return { ...base, sessionOrg: async () => ({ orgId: ORG, ownerType: "user", ownerId: "u-001" }), metrics: { matched: vi.fn(), failed } };
    }

    it("completes ingest and drops the candidate when the Linear state lookup never answers", async () => {
      const lookups = vi.fn(never);
      await store.createWakeup({
        ...waiter(), id: "wk_lin", subjects: ["linear:team/ENG"], createdAt: 2,
        eventMatch: { clauses: [{ key: "linear.issue.update", status: ["triage"], from_status: ["backlog"] }], once: false, self: [] },
      });
      const update: NormalizedEvent = {
        key: "linear.issue.update", dedupeKey: "lin-timeout-1", occurredAt: "2026-10-15T00:00:00.000Z",
        refs: {}, summary: "ENG-9 moved", status: "triage", subjects: ["linear:team/ENG", "linear:ENG-9"],
        payload: { data: { team: { key: "ENG-TIMEOUT" } }, updatedFrom: { stateId: "state-backlog" } },
      };
      const started = Date.now();
      const result = await ingestEvent(
        { db: db.appDb, plugins: [linearPlugin], waiters: boundedDeps({ providerTimeoutMs: 50, fetch: lookups }) },
        { orgId: ORG, service: "linear", event: update },
      );
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(result).toMatchObject({ skipped: true });
      expect(lookups).toHaveBeenCalledTimes(1);
      expect((await store.getWakeup("wk_lin"))?.eventBuffer).toEqual([]);
      expect(await stagesOf()).toContainEqual({ stage: "waiter_match", outcome: "none", detail: "0 event waiters matched." });
      expect(failed).not.toHaveBeenCalled();
    });

    it("completes ingest and drops the candidate when the Slack channel check never answers", async () => {
      const result = await ingest(message("Ev-slow"), boundedDeps({ providerTimeoutMs: 50, channelVisibility: () => never }));
      expect(result).toMatchObject({ skipped: true });
      expect((await store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
      expect(await stagesOf()).toContainEqual({ stage: "waiter_match", outcome: "none", detail: "0 event waiters matched." });
    });
  });

  /** The waiter's thread `t-1` can receive a delivery of team-1. */
  const deliverable: Partial<ClaimDeps> = { isDeliverable: async () => true };

  /** Links U002 to a team-1 member, so the team mention gate admits U002. */
  async function linkSender(): Promise<void> {
    await db.appDb.insert(teams).values({ id: "team-1", orgId: ORG, name: "SRE", createdAt: 1 });
    await db.appDb.insert(teamMembers).values({ teamId: "team-1", userId: "u-002", role: "member" });
    await db.appDb.insert(orgMembers).values({ orgId: ORG, userId: "u-002", role: "member" });
    await db.appDb.insert(userIdentityLinks).values({ id: "link-u002", provider: "slack", externalId: "U002", userId: "u-002", createdAt: 1 });
  }

  async function subscribeMessages(target: unknown = { kind: "orchestrator" }): Promise<void> {
    await db.appDb.insert(eventSubscriptions).values({
      id: "msg-sub", orgId: ORG, ownerType: "team", ownerId: "team-1", createdBy: "u-001",
      name: "Channel", eventKeys: ["slack.message"], filters: [],
      target, enabled: true, createdAt: 1, updatedAt: 1,
    });
  }

  function mention(dedupeKey: string): NormalizedEvent {
    const m = message(dedupeKey, "<@U-BOT> status?");
    return { ...m, key: "slack.app_mention", payload: { type: "app_mention", channel: "C001", user: "U002", text: "<@U-BOT> status?", thread_ts: "1712345678.000100" } };
  }

  async function deliveryStamps(): Promise<unknown[]> {
    return (await db.appDb.select().from(eventDeliveries)).map((d) => d.destination);
  }

  it("suppresses the message digest of a mention that the owner's rule delivers (Part C step 8)", async () => {
    await subscribeAppMention();
    await linkSender();
    await ingest(message("Ev-m1", "<@U-BOT> status?"), waiterDeps(), deliverable);
    expect((await store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
  });

  it("stamps the mention's redirect to the waiting thread and appends no digest (C2)", async () => {
    await subscribeAppMention();
    await linkSender();
    const result = await ingest(mention("Ev-m1:mention"), waiterDeps(), deliverable);
    expect(result).toMatchObject({ deliveries: 1 });
    expect(await deliveryStamps()).toEqual([{ kind: "target", sessionId: "s-1", threadId: "t-1", reason: "claim_redirect" }]);
    expect((await store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
  });

  it("appends the message digest of a mention that the team gate refuses (C4)", async () => {
    await subscribeAppMention();
    await ingest(message("Ev-m4", "<@U-BOT> status?"), waiterDeps(), deliverable);
    expect((await store.getWakeup("wk_1"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["Ev-m4"]);
  });

  it("stamps an ambient channel message as claimed by the waiting thread, which appends (C1)", async () => {
    await subscribeMessages();
    await ingest(message("Ev-c1"), waiterDeps(), deliverable);
    expect(await deliveryStamps()).toEqual([{ kind: "skip", reason: "claimed by thread t-1" }]);
    expect((await store.getWakeup("wk_1"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["Ev-c1"]);
    expect(await stagesOf()).toContainEqual({ stage: "waiter_match", outcome: "matched", detail: "1 event waiter matched." });
  });

  it("never stamps a workflow delivery (INV-D7)", async () => {
    await subscribeMessages({ kind: "workflow", workflowId: "wf-1" });
    await ingest(message("Ev-w1"), waiterDeps(), deliverable);
    expect(await deliveryStamps()).toEqual([null]);
    expect((await store.getWakeup("wk_1"))?.eventBuffer).toHaveLength(1);
  });

  it("leaves the delivery unstamped and the waiter appending when claim resolution throws (INV-D6)", async () => {
    await subscribeMessages();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await ingest(message("Ev-f1"), waiterDeps(), { isDeliverable: async () => { throw new Error("db down"); } });
    expect(result).toMatchObject({ deliveries: 1 });
    expect(await deliveryStamps()).toEqual([null]);
    expect((await store.getWakeup("wk_1"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["Ev-f1"]);
    expect(await stagesOf()).toContainEqual({ stage: "claim_resolution", outcome: "failed", detail: expect.stringContaining("thread policy") });
    expect(failed).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("matches a bot mention when no app_mention subscription covers the channel", async () => {
    await ingest(message("Ev-m2", "<@U-BOT> status?"), waiterDeps(), deliverable);
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
