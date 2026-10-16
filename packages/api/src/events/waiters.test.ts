import { describe, expect, it, vi } from "vitest";
import {
  InMemorySessionStore,
  type DerivedEventDef,
  type EventMatchSpec,
  type NormalizedEvent,
  type ValetPlugin,
  type Wakeup,
} from "@valet/engine";
import { linearPreviousStatusRef, matchEventWaiters, type WaiterMatchDeps } from "./waiters.js";

const ORG = "acme";
const THREAD_SUBJECT = "slack:T001/C001/1712345678.000100";

function slackMessage(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    key: "slack.message",
    dedupeKey: "Ev-1",
    occurredAt: "2026-10-15T00:00:00.000Z",
    refs: { channel: "C001" },
    summary: "U002 replied",
    payload: { type: "message", channel: "C001", user: "U002", text: "Looks good, ship it", thread_ts: "1712345678.000100" },
    actor: { externalId: "U002", bot: false },
    subjects: ["slack:T001", "slack:T001/C001", THREAD_SUBJECT],
    ...over,
  };
}

function waiter(over: Partial<Wakeup> = {}): Wakeup {
  const eventMatch: EventMatchSpec = { clauses: [{ key: "slack.message", bots: false }], once: true, self: [] };
  return {
    id: "wk_1", sessionId: "s-1", threadId: "t-1", kind: "event", status: "running", reason: "Reply from Grace",
    logOffset: 0, logTail: "", eventCount: 0, createdAt: 1, updatedAt: 1, deadlineAt: 10_000_000,
    subjects: [THREAD_SUBJECT], eventMatch, eventBuffer: [],
    ...over,
  };
}

interface Harness {
  deps: WaiterMatchDeps;
  store: InMemorySessionStore;
  nudge: ReturnType<typeof vi.fn>;
  matched: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
}

function harness(over: Partial<WaiterMatchDeps> = {}, sessions: Record<string, string> = { "s-1": ORG }): Harness {
  const store = new InMemorySessionStore();
  const nudge = vi.fn();
  const matched = vi.fn();
  const failed = vi.fn();
  const deps: WaiterMatchDeps = {
    engineStore: store,
    sessionOrg: async (id) => (sessions[id] ? { orgId: sessions[id], ownerType: "user", ownerId: "u-001" } : null),
    plugins: [],
    slackStillVisible: async () => true,
    resolvePreviousStatus: async () => null,
    nudge,
    now: () => 5_000,
    slackBotUserId: async () => "U-BOT",
    appMentionCovered: async () => false,
    metrics: { matched, failed },
    ...over,
  };
  return { deps, store, nudge, matched, failed };
}

describe("matchEventWaiters", () => {
  it("appends a digest to a matching waiter, nudges once, and counts the match", async () => {
    const h = harness();
    await h.store.createWakeup(waiter());
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(1);
    const row = await h.store.getWakeup("wk_1");
    expect(row?.eventBuffer?.map((d) => [d.dedupeKey, d.text])).toEqual([["Ev-1", "Looks good, ship it"]]);
    expect(row?.updatedAt).toBe(5_000);
    expect(h.nudge).toHaveBeenCalledTimes(1);
    expect(h.nudge).toHaveBeenCalledWith(["wk_1"]);
    expect(h.matched).toHaveBeenCalledWith("slack");
  });

  it("gives nothing to a waiter whose session is in another org (E1 org row)", async () => {
    const h = harness({}, { "s-1": "other-org" });
    await h.store.createWakeup(waiter());
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(0);
    expect((await h.store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
    expect(h.nudge).not.toHaveBeenCalled();
  });

  it("gives nothing to a waiter whose session is gone", async () => {
    const h = harness({}, {});
    await h.store.createWakeup(waiter());
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(0);
    expect((await h.store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
    expect(h.nudge).not.toHaveBeenCalled();
  });

  it("appends a redelivered dedupeKey once and nudges only for the first", async () => {
    const h = harness();
    await h.store.createWakeup(waiter());
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(1);
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(0);
    expect((await h.store.getWakeup("wk_1"))?.eventBuffer).toHaveLength(1);
    expect(h.nudge).toHaveBeenCalledTimes(1);
  });

  it("drops a Slack candidate whose channel is no longer visible to the session", async () => {
    const visible = vi.fn(async () => false);
    const h = harness({ slackStillVisible: visible });
    await h.store.createWakeup(waiter());
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(0);
    expect(visible).toHaveBeenCalledWith({ sessionId: "s-1", orgId: ORG, ownerType: "user", ownerId: "u-001" }, "C001");
    expect((await h.store.getWakeup("wk_1"))?.eventBuffer).toEqual([]);
    expect(h.nudge).not.toHaveBeenCalled();
  });

  it("checks Slack visibility once per owner and channel for one event", async () => {
    const visible = vi.fn(async () => true);
    const h = harness({ slackStillVisible: visible }, { "s-1": ORG, "s-2": ORG });
    await h.store.createWakeup(waiter());
    await h.store.createWakeup(waiter({ id: "wk_2", threadId: "t-2", createdAt: 2 }));
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(2);
    expect(visible).toHaveBeenCalledTimes(1);
  });

  it("does not nudge when no clause matches", async () => {
    const h = harness();
    await h.store.createWakeup(waiter());
    const bot = slackMessage({ actor: { externalId: "B9", bot: true } });
    expect((await matchEventWaiters(h.deps, ORG, "slack", bot)).appended).toBe(0);
    expect(h.nudge).not.toHaveBeenCalled();
  });

  it("skips a bot mention that an enabled app_mention subscription covers", async () => {
    const covered = vi.fn(async () => true);
    const h = harness({ appMentionCovered: covered });
    await h.store.createWakeup(waiter());
    const mention = slackMessage({ payload: { type: "message", channel: "C001", user: "U002", text: "<@U-BOT> status?" } });
    expect((await matchEventWaiters(h.deps, ORG, "slack", mention)).appended).toBe(0);
    expect(covered).toHaveBeenCalledWith(ORG, mention);
  });

  it("matches a bot mention when no app_mention subscription covers the channel", async () => {
    const h = harness({ appMentionCovered: async () => false });
    await h.store.createWakeup(waiter());
    const mention = slackMessage({ payload: { type: "message", channel: "C001", user: "U002", text: "<@U-BOT> status?" } });
    expect((await matchEventWaiters(h.deps, ORG, "slack", mention)).appended).toBe(1);
  });

  it("marks a digest that matched through a derived key's sources", async () => {
    const derived: DerivedEventDef = {
      key: "github.pull_request.checks_completed", description: "checks settled",
      sources: ["github.check_run.completed"], derive: async () => null,
    };
    const plugin: ValetPlugin = { name: "github", version: "0", derivedEvents: [derived] };
    const h = harness({ plugins: [plugin] });
    await h.store.createWakeup(waiter({
      subjects: ["github:acme/lean-proofs#42"],
      eventMatch: { clauses: [{ key: "github.pull_request.checks_completed" }], once: false, self: [] },
    }));
    const checkRun: NormalizedEvent = {
      key: "github.check_run.completed", dedupeKey: "gh-1", occurredAt: "2026-10-15T00:00:00.000Z",
      refs: {}, summary: "check run completed", payload: {}, status: "success",
      subjects: ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42"],
    };
    expect((await matchEventWaiters(h.deps, ORG, "github", checkRun)).appended).toBe(1);
    expect((await h.store.getWakeup("wk_1"))?.eventBuffer?.[0]?.derive).toBe("github.pull_request.checks_completed");
  });

  describe("derived and direct clauses on a pull request (final review, items 2 and 3)", () => {
    const CHECKS = "github.pull_request.checks_completed";
    const PR = "github:acme/lean-proofs#42";
    const REPO = "github:acme/lean-proofs";
    const plugin: ValetPlugin = {
      name: "github",
      version: "0",
      derivedEvents: [{
        key: CHECKS, description: "checks settled", derive: async () => null,
        sources: ["github.check_run.completed", "github.status"],
      }],
    };
    const prWaiter = () => waiter({
      subjects: [PR, REPO],
      eventMatch: {
        clauses: [{ key: CHECKS }, { key: "github.check_run.completed", status: ["failure"] }],
        once: false, self: [], primarySubject: PR,
      },
    });
    const ghEvent = (over: Partial<NormalizedEvent>): NormalizedEvent => ({
      key: "github.check_run.completed", dedupeKey: "gh-1", occurredAt: "2026-10-15T00:00:00.000Z",
      refs: {}, summary: "check run completed", payload: {}, ...over,
    });

    it("buffers both the direct digest and the derive digest of a mid-run failure", async () => {
      const h = harness({ plugins: [plugin] });
      await h.store.createWakeup(prWaiter());
      const failure = ghEvent({ status: "failure", subjects: ["github:acme", REPO, PR, `${REPO}@aaaa`] });
      expect((await matchEventWaiters(h.deps, ORG, "github", failure)).appended).toBe(1);
      const buffer = (await h.store.getWakeup("wk_1"))?.eventBuffer ?? [];
      expect(buffer.map((d) => [d.dedupeKey, d.derive])).toEqual([["gh-1", undefined], [`derive:${CHECKS}:gh-1`, CHECKS]]);
    });

    it("finds a PR waiter for a commit status through the repository subject, as a derive digest only", async () => {
      const h = harness({ plugins: [plugin] });
      await h.store.createWakeup(prWaiter());
      const status = ghEvent({ key: "github.status", dedupeKey: "st-1", status: "success", subjects: ["github:acme", REPO, `${REPO}@aaaa`] });
      expect((await matchEventWaiters(h.deps, ORG, "github", status)).appended).toBe(1);
      const buffer = (await h.store.getWakeup("wk_1"))?.eventBuffer ?? [];
      expect(buffer.map((d) => [d.dedupeKey, d.derive])).toEqual([[`derive:${CHECKS}:st-1`, CHECKS]]);
    });

    it("never matches a direct clause for a check run on another pull request in the repository", async () => {
      const h = harness({ plugins: [plugin] });
      await h.store.createWakeup(prWaiter());
      const other = ghEvent({ dedupeKey: "gh-7", status: "failure", subjects: ["github:acme", REPO, "github:acme/lean-proofs#7", `${REPO}@bbbb`] });
      expect((await matchEventWaiters(h.deps, ORG, "github", other)).appended).toBe(1);
      const buffer = (await h.store.getWakeup("wk_1"))?.eventBuffer ?? [];
      // Only the derive digest; `derive` returns null for a SHA that is not the head.
      expect(buffer.map((d) => d.derive)).toEqual([CHECKS]);
    });
  });

  it("resolves the previous status once for a from_status clause", async () => {
    const resolve = vi.fn(async () => "backlog");
    const h = harness({ resolvePreviousStatus: resolve });
    const spec: EventMatchSpec = {
      clauses: [{ key: "linear.issue.update", status: ["triage"], from_status: ["backlog"] }], once: false, self: [],
    };
    await h.store.createWakeup(waiter({ subjects: ["linear:team/ENG"], eventMatch: spec }));
    await h.store.createWakeup(waiter({ id: "wk_2", subjects: ["linear:team/ENG"], eventMatch: spec, createdAt: 2 }));
    const update: NormalizedEvent = {
      key: "linear.issue.update", dedupeKey: "lin-1", occurredAt: "2026-10-15T00:00:00.000Z",
      refs: {}, summary: "ENG-9 moved", status: "triage", subjects: ["linear:team/ENG", "linear:ENG-9"],
      payload: { data: { team: { key: "ENG" } }, updatedFrom: { stateId: "state-backlog" } },
    };
    expect((await matchEventWaiters(h.deps, ORG, "linear", update)).appended).toBe(2);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await h.store.getWakeup("wk_1"))?.eventBuffer?.[0]?.previousStatus).toBe("backlog");
  });

  it("does not match a title-only update for a from_status clause", async () => {
    const h = harness({ resolvePreviousStatus: async () => null });
    await h.store.createWakeup(waiter({
      subjects: ["linear:team/ENG"],
      eventMatch: { clauses: [{ key: "linear.issue.update", status: ["triage"], from_status: ["backlog"] }], once: false, self: [] },
    }));
    const update: NormalizedEvent = {
      key: "linear.issue.update", dedupeKey: "lin-2", occurredAt: "2026-10-15T00:00:00.000Z",
      refs: {}, summary: "ENG-8 title", status: "triage", subjects: ["linear:team/ENG", "linear:ENG-8"],
      payload: { data: { team: { key: "ENG" } }, updatedFrom: { title: "old" } },
    };
    expect((await matchEventWaiters(h.deps, ORG, "linear", update)).appended).toBe(0);
  });

  it("keeps matching other candidates when one candidate fails, and counts the failure", async () => {
    const h = harness({}, { "s-1": ORG, "s-2": ORG });
    const sessionOrg = h.deps.sessionOrg;
    h.deps.sessionOrg = async (id) => {
      if (id === "s-1") throw new Error("db down");
      return sessionOrg(id);
    };
    await h.store.createWakeup(waiter());
    await h.store.createWakeup(waiter({ id: "wk_2", sessionId: "s-2", createdAt: 2 }));
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage())).appended).toBe(1);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect((await h.store.getWakeup("wk_2"))?.eventBuffer).toHaveLength(1);
  });

  it("returns 0 without a store read for an event with no subjects", async () => {
    const h = harness();
    const find = vi.spyOn(h.store, "findEventWaiters");
    expect((await matchEventWaiters(h.deps, ORG, "slack", slackMessage({ subjects: [] }))).appended).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("linearPreviousStatusRef", () => {
  it("reads the team key and the previous state id", () => {
    expect(linearPreviousStatusRef({ data: { team: { key: "ENG" } }, updatedFrom: { stateId: "s-9" } }))
      .toEqual({ teamKey: "ENG", stateId: "s-9" });
  });
  it("returns null when the update did not change the state", () => {
    expect(linearPreviousStatusRef({ data: { team: { key: "ENG" } }, updatedFrom: { title: "x" } })).toBeNull();
  });
});
