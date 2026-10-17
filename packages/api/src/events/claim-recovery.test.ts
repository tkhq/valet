import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore, type EventMatchSpec, type NormalizedEvent, type Wakeup } from "@valet/engine";
import slackPlugin from "@valet/plugin-slack/plugin";
import { appendClaimedWaiterDigest } from "./claim-recovery.js";
import type { WaiterMatchDeps } from "./waiters.js";

const ORG = "acme";

function mention(): NormalizedEvent {
  return {
    key: "slack.app_mention",
    dedupeKey: "Ev-9:mention",
    occurredAt: "2026-10-16T00:00:00.000Z",
    refs: { channel: "C900" },
    summary: "U001 mentioned the bot",
    payload: { type: "app_mention", channel: "C900", user: "U001", text: "<@U-BOT> status?", ts: "1.2" },
    actor: { externalId: "U001", bot: false },
    subjects: ["slack:T001", "slack:T001/C900", "slack:T001/C900/1.2"],
  };
}

function waiter(over: Partial<Wakeup> = {}): Wakeup {
  const eventMatch: EventMatchSpec = { clauses: [{ key: "slack.message", bots: false }], once: true, self: [] };
  return {
    id: "w-inc", sessionId: "s-inc", threadId: "t-inc", kind: "event", status: "running", reason: "Incident",
    logOffset: 0, logTail: "", eventCount: 0, createdAt: 1, updatedAt: 1, deadlineAt: 10_000_000,
    subjects: ["slack:T001/C900"], eventMatch, eventBuffer: [],
    ...over,
  };
}

function harness(over: Partial<WaiterMatchDeps> = {}) {
  const store = new InMemorySessionStore();
  const nudge = vi.fn();
  const deps: WaiterMatchDeps = {
    engineStore: store,
    sessionOrg: async (id) => (id === "s-inc" ? { orgId: ORG, ownerType: "team", ownerId: "sre" } : null),
    plugins: [slackPlugin],
    slackStillVisible: async () => true,
    resolvePreviousStatus: async () => null,
    nudge,
    now: () => 5_000,
    slackBotUserId: async () => "U-BOT",
    ...over,
  };
  return { deps, store, nudge };
}

const args = { waiterId: "w-inc", orgId: ORG, service: "slack", event: mention() };

describe("appendClaimedWaiterDigest", () => {
  it("appends the twin's digest to a slack.message waiter once, and nudges it", async () => {
    const h = harness();
    await h.store.createWakeup(waiter());
    expect(await appendClaimedWaiterDigest(h.deps, args)).toBe(true);
    expect(await appendClaimedWaiterDigest(h.deps, args)).toBe(false);
    const row = await h.store.getWakeup("w-inc");
    expect(row?.eventBuffer?.map((d) => d.key)).toEqual(["slack.message"]);
    expect(h.nudge).toHaveBeenCalledOnce();
    expect(h.nudge).toHaveBeenCalledWith(["w-inc"]);
  });

  it("gives nothing to a waiter that ended, moved org, or lost the channel", async () => {
    const ended = harness();
    await ended.store.createWakeup(waiter({ status: "done" }));
    expect(await appendClaimedWaiterDigest(ended.deps, args)).toBe(false);

    const otherOrg = harness({ sessionOrg: async () => ({ orgId: "other", ownerType: "team", ownerId: "sre" }) });
    await otherOrg.store.createWakeup(waiter());
    expect(await appendClaimedWaiterDigest(otherOrg.deps, args)).toBe(false);

    const hidden = harness({ slackStillVisible: async () => false });
    await hidden.store.createWakeup(waiter());
    expect(await appendClaimedWaiterDigest(hidden.deps, args)).toBe(false);
    expect((await hidden.store.getWakeup("w-inc"))?.eventBuffer).toEqual([]);
  });

  it("gives nothing when neither the event nor its twin matches the clauses", async () => {
    const h = harness();
    await h.store.createWakeup(waiter({ eventMatch: { clauses: [{ key: "slack.reaction_added" }], once: true, self: [] } }));
    expect(await appendClaimedWaiterDigest(h.deps, args)).toBe(false);
    expect(h.nudge).not.toHaveBeenCalled();
  });
});
