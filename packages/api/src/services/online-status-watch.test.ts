import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, type NormalizedEvent } from "@valet/engine";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { OnlineStatusResult } from "@valet/plugin-slack/actions";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { eventDeliveries, eventSubscriptions } from "../schema/index.js";
import { ingestEvent } from "../events/ingest.js";
import { validateSubscription } from "../events/subscription-write.js";
import {
  MAX_BACKOFF_MS,
  MAX_POLLS_PER_TICK,
  MAX_WATCHED_PER_ORG,
  MIN_AWAY_MS,
  OnlineStatusWatcher,
  POLL_INTERVAL_MS,
  type WatchState,
  applyPresence,
  backoffMs,
  watchedUsers,
} from "./online-status-watch.js";

const ORG = "org-1";

function line(id: string, users: string | string[], over: Partial<typeof eventSubscriptions.$inferInsert> = {}): typeof eventSubscriptions.$inferInsert {
  return {
    id, orgId: ORG, ownerType: "user", ownerId: "u-1", createdBy: "u-1", name: id,
    eventKeys: ["slack.user_online"],
    filters: [Array.isArray(users) ? { field: "user", op: "in", value: users } : { field: "user", op: "eq", value: users }],
    target: { kind: "workflow", workflowId: "wf-1" },
    enabled: true, createdAt: 1, updatedAt: 1,
    ...over,
  };
}

describe("watchedUsers", () => {
  it("collects the named people of enabled slack.user_online lines only", () => {
    const rows = [
      { orgId: ORG, eventKeys: ["slack.user_online"], filters: [{ field: "user", op: "eq", value: "U1" }], enabled: true },
      { orgId: ORG, eventKeys: ["slack.user_online"], filters: [{ field: "user", op: "in", value: ["U2", "U1"] }], enabled: true },
      { orgId: ORG, eventKeys: ["slack.user_online"], filters: [{ field: "user", op: "eq", value: "U3" }], enabled: false },
      // A wildcard line names a person's messages, not their online status.
      { orgId: ORG, eventKeys: ["slack.*"], filters: [{ field: "user", op: "eq", value: "U4" }], enabled: true },
      { orgId: ORG, eventKeys: ["slack.message"], filters: [{ field: "user", op: "eq", value: "U5" }], enabled: true },
    ];
    expect(watchedUsers(rows)).toEqual(new Map([[ORG, ["U1", "U2"]]]));
  });

  it("caps the people per org", () => {
    const users = Array.from({ length: MAX_WATCHED_PER_ORG + 5 }, (_, i) => `U${String(i).padStart(3, "0")}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = watchedUsers([{ orgId: ORG, eventKeys: ["slack.user_online"], filters: [{ field: "user", op: "in", value: users }], enabled: true }]);
    expect(out.get(ORG)).toHaveLength(MAX_WATCHED_PER_ORG);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("applyPresence", () => {
  const state = (): WatchState => ({ nextPollAt: 0, failures: 0, verified: true });

  it("fires on away to active after the minimum away time, with the away length", () => {
    const s: WatchState = { ...state(), presence: "active" };
    expect(applyPresence(s, "away", 1_000)).toBeNull();
    expect(applyPresence(s, "away", 1_000 + POLL_INTERVAL_MS)).toBeNull();
    expect(applyPresence(s, "active", 1_000 + MIN_AWAY_MS)).toBe(MIN_AWAY_MS);
    expect(s.awaySince).toBeUndefined();
  });

  it("ignores a short away blip (debounce)", () => {
    const s: WatchState = { ...state(), presence: "active" };
    applyPresence(s, "away", 0);
    expect(applyPresence(s, "active", MIN_AWAY_MS - 1)).toBeNull();
  });

  it("treats the first read as the baseline and never fires on it", () => {
    expect(applyPresence(state(), "active", 0)).toBeNull();
    const away = state();
    expect(applyPresence(away, "away", 0)).toBeNull();
    expect(away.awaySince).toBe(0);
  });

  it("does not fire for active to active", () => {
    const s: WatchState = { ...state(), presence: "active" };
    expect(applyPresence(s, "active", MIN_AWAY_MS * 10)).toBeNull();
  });
});

describe("backoffMs", () => {
  it("doubles from the poll interval up to the cap, and honors Retry-After", () => {
    expect(backoffMs(1)).toBe(POLL_INTERVAL_MS);
    expect(backoffMs(2)).toBe(2 * POLL_INTERVAL_MS);
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(1, 300)).toBe(300_000);
    expect(backoffMs(1, undefined, true)).toBe(MAX_BACKOFF_MS);
  });
});

describe("OnlineStatusWatcher", () => {
  let db: TestPgDb;
  let now: number;
  let presence: Map<string, "active" | "away" | OnlineStatusResult>;
  /** The answer a full read (with the workspace check) gives instead, when set. */
  let members: Map<string, OnlineStatusResult>;
  let reads: { user: string; profile: boolean | undefined }[];
  let events: NormalizedEvent[];
  let credentials: InMemoryCredentialStore;

  beforeEach(async () => {
    db = await freshTestPgDb();
    now = 1_000_000;
    presence = new Map();
    members = new Map();
    reads = [];
    events = [];
    credentials = new InMemoryCredentialStore();
    await credentials.save({ type: "org", id: ORG }, "slack", { type: "bot_token", accessToken: "xoxb-1", metadata: { teamId: "T1" } });
  });

  afterEach(async () => {
    await db.cleanup();
  });

  function watcher(): OnlineStatusWatcher {
    return new OnlineStatusWatcher({
      db: db.appDb, plugins: [slackPlugin], credentials, now: () => now,
      readStatus: async (_token, user, opts) => {
        reads.push({ user, profile: opts?.profile });
        const membership = opts?.profile !== false ? members.get(user) : undefined;
        if (membership) return membership;
        const value = presence.get(user) ?? "away";
        if (typeof value === "object") return value;
        return { ok: true, status: { user, presence: value, online: value === "active" } };
      },
      ingest: async (_org, event) => { events.push(event); },
    });
  }

  it("emits one slack.user_online event for an away to active change, then nothing while active", async () => {
    await db.appDb.insert(eventSubscriptions).values(line("l1", "U1"));
    const w = watcher();
    presence.set("U1", "active");
    await w.tick(); // baseline
    presence.set("U1", "away");
    now += POLL_INTERVAL_MS;
    await w.tick();
    now += MIN_AWAY_MS;
    presence.set("U1", "active");
    await w.tick();
    now += POLL_INTERVAL_MS;
    await w.tick();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: "slack.user_online", refs: { user: "U1", team: "T1" }, payload: { user: "U1", away_minutes: 5 } });
    expect(events[0]!.dedupeKey).toBe(`user_online:T1:U1:${1_000_000 + POLL_INTERVAL_MS}`);
    // The first read checks the workspace with users.info; later reads only
    // read presence, and the read that would fire checks the workspace again.
    expect(reads.map((r) => r.profile)).toEqual([true, false, false, true, false]);
  });

  it("does not fire for a person who left the workspace after the baseline", async () => {
    await db.appDb.insert(eventSubscriptions).values(line("l1", "U1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = watcher();
    presence.set("U1", "away");
    await w.tick(); // baseline, a member
    members.set("U1", { ok: false, code: "other_workspace", error: "not a member" });
    now += MIN_AWAY_MS;
    presence.set("U1", "active");
    await w.tick();
    expect(events).toHaveLength(0);
    // The next read waits the longest backoff and repeats the full check.
    now += MAX_BACKOFF_MS;
    await w.tick();
    expect(reads.at(-1)?.profile).toBe(true);
    expect(events).toHaveLength(0);
    warn.mockRestore();
  });

  it("does not fire when the confirming read sees the person away again", async () => {
    await db.appDb.insert(eventSubscriptions).values(line("l1", "U1"));
    const w = watcher();
    presence.set("U1", "away");
    await w.tick(); // baseline
    now += MIN_AWAY_MS;
    presence.set("U1", "active");
    members.set("U1", { ok: true, status: { user: "U1", name: "u1", presence: "away", online: false } });
    await w.tick();
    expect(events).toHaveLength(0);
    // The next return counts from the away the confirming read saw.
    members.delete("U1");
    now += MIN_AWAY_MS;
    await w.tick();
    expect(events).toHaveLength(1);
  });

  it("polls each person at most once per interval", async () => {
    await db.appDb.insert(eventSubscriptions).values(line("l1", "U1"));
    const w = watcher();
    await w.tick();
    now += POLL_INTERVAL_MS - 1;
    await w.tick();
    expect(reads).toHaveLength(1);
    now += 1;
    await w.tick();
    expect(reads).toHaveLength(2);
  });

  it("bounds the reads in one tick", async () => {
    const users = Array.from({ length: MAX_WATCHED_PER_ORG }, (_, i) => `U${String(i).padStart(3, "0")}`);
    await db.appDb.insert(eventSubscriptions).values([
      line("l1", users),
      line("l2", users, { orgId: "org-2" }),
    ]);
    await credentials.save({ type: "org", id: "org-2" }, "slack", { type: "bot_token", accessToken: "xoxb-2" });
    await watcher().tick();
    expect(reads).toHaveLength(MAX_POLLS_PER_TICK);
  });

  it("backs off after a failed read and waits longest for a missing scope", async () => {
    await db.appDb.insert(eventSubscriptions).values(line("l1", "U1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    presence.set("U1", { ok: false, code: "missing_scope", error: "needs users:read" });
    const w = watcher();
    await w.tick();
    now += MAX_BACKOFF_MS - 1;
    await w.tick();
    expect(reads).toHaveLength(1);
    now += 1;
    await w.tick();
    expect(reads).toHaveLength(2);
    warn.mockRestore();
  });

  it("drops a person's state when no enabled line names them", async () => {
    await db.appDb.insert(eventSubscriptions).values(line("l1", "U1"));
    const w = watcher();
    await w.tick();
    expect(w.watchedKeys()).toEqual([`${ORG}:U1`]);
    await db.appDb.update(eventSubscriptions).set({ enabled: false });
    await w.tick();
    expect(w.watchedKeys()).toEqual([]);
  });
});

describe("slack.user_online lines", () => {
  it("must name the person to watch", () => {
    const body = { name: "back online", eventKeys: ["slack.user_online"], target: { kind: "workflow", workflowId: "wf-1" } };
    expect(validateSubscription([slackPlugin], { ...body, filters: [] })).toBe(
      "slack.user_online needs the person to watch. Add a condition: user is <their Slack user>.",
    );
    expect(validateSubscription([slackPlugin], { ...body, filters: [{ field: "user", op: "eq", value: "U1" }] })).toBeNull();
  });

  it("accept a whole number of hours for oncePerHours and refuse anything else", () => {
    const body = { name: "n", eventKeys: ["slack.user_online"], filters: [{ field: "user", op: "eq", value: "U1" }] };
    expect(validateSubscription([slackPlugin], { ...body, target: { kind: "workflow", workflowId: "wf-1", oncePerHours: 4 } })).toBeNull();
    expect(validateSubscription([slackPlugin], { ...body, target: { kind: "workflow", workflowId: "wf-1", oncePerHours: 0 } })).toMatch(/^oncePerHours must be a whole number/);
    expect(validateSubscription([slackPlugin], { ...body, target: { kind: "workflow", workflowId: "wf-1", oncePerHours: 1.5 } })).toMatch(/^oncePerHours must be a whole number/);
  });
});

describe("once every N hours", () => {
  let db: TestPgDb;
  beforeEach(async () => { db = await freshTestPgDb(); });
  afterEach(async () => { await db.cleanup(); });

  function online(dedupeKey: string): NormalizedEvent {
    return {
      key: "slack.user_online", dedupeKey, occurredAt: new Date().toISOString(),
      refs: { user: "U1" }, summary: "U1 came online", payload: { type: "user_online", user: "U1" },
    };
  }

  it("skips a line that already delivered inside its window, and records why", async () => {
    await db.appDb.insert(eventSubscriptions).values([
      line("limited", "U1", { target: { kind: "workflow", workflowId: "wf-1", oncePerHours: 4 } }),
      line("every", "U1"),
    ]);
    const deps = { db: db.appDb, plugins: [slackPlugin] };
    await ingestEvent(deps, { orgId: ORG, service: "slack", event: online("a") });
    await ingestEvent(deps, { orgId: ORG, service: "slack", event: online("b") });

    const rows = await db.appDb.select().from(eventDeliveries);
    const bySub = (id: string) => rows.filter((r) => r.subscriptionId === id).length;
    expect(bySub("limited")).toBe(1);
    expect(bySub("every")).toBe(2);
  });

  it("admits one delivery when two events for a limited line ingest at once", async () => {
    await db.appDb.insert(eventSubscriptions).values(
      line("limited", "U1", { target: { kind: "workflow", workflowId: "wf-1", oncePerHours: 4 } }),
    );
    const deps = { db: db.appDb, plugins: [slackPlugin] };
    const results = await Promise.all(["c1", "c2", "c3"].map((key) =>
      ingestEvent(deps, { orgId: ORG, service: "slack", event: online(key) })));

    const rows = await db.appDb.select().from(eventDeliveries);
    expect(rows.filter((r) => r.subscriptionId === "limited")).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.deliveries, 0)).toBe(1);
  });
});
