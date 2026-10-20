/**
 * Claim resolution vectors (spec 2026-10-16: delivery threads and claims,
 * Part C), over fakes. Each test names its Scenario C step or the plan's
 * Review Focus item.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventMatchSpec, NormalizedEvent, Principal, Wakeup } from "@valet/engine";
import slackPlugin from "@valet/plugin-slack/plugin";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, teamMembers, teams, userIdentityLinks } from "../schema/index.js";
import { catalogForService } from "./ingest.js";
import { toDigest } from "./waiter-match.js";
import type { ConversationBinding } from "./conversation-binding.js";
import { mentionCoveredBy, resolveClaims, withTwinCandidates, type ClaimDeps, type ClaimSubscription, type ResolveClaimsArgs } from "./claims.js";
import type { WaiterCandidate } from "./waiters.js";

const ORG = "acme";
const SRE: Principal = { type: "team", id: "sre" };
const PLATFORM: Principal = { type: "team", id: "platform" };
const U001: Principal = { type: "user", id: "u-001" };
const CHANNEL = "slack:T001/C900";

function event(over: Partial<NormalizedEvent> & Pick<NormalizedEvent, "key">): NormalizedEvent {
  return { dedupeKey: "ev-1", occurredAt: "2026-10-16T00:00:00.000Z", refs: {}, summary: "event", payload: {}, ...over };
}

function slackEvent(key: "slack.message" | "slack.app_mention", threadTs?: string, over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const subjects = ["slack:T001", CHANNEL, ...(threadTs ? [`${CHANNEL}/${threadTs}`] : [])];
  return event({
    key, dedupeKey: key === "slack.app_mention" ? "ev-1:mention" : "ev-1", subjects,
    payload: { type: key === "slack.message" ? "message" : "app_mention", channel: "C900", user: "U001", text: "<@U-BOT> status?", ts: "2.0", ...(threadTs ? { thread_ts: threadTs } : {}) },
    ...over,
  });
}

/** The twin pair for one Slack post. */
function twins(threadTs?: string): { message: NormalizedEvent; mention: NormalizedEvent } {
  return { message: slackEvent("slack.message", threadTs), mention: slackEvent("slack.app_mention", threadTs) };
}

function sub(id: string, owner: Principal, kind: "orchestrator" | "workflow" = "orchestrator"): ClaimSubscription {
  return { id, ownerType: owner.type, ownerId: owner.id, target: kind === "workflow" ? { kind, workflowId: "wf-1" } : { kind } };
}

interface CandidateOpts {
  owner: Principal;
  sessionId: string;
  threadId: string;
  subjects: string[];
  createdAt?: number;
  once?: boolean;
  accepted?: boolean;
}

function candidate(id: string, e: NormalizedEvent, opts: CandidateOpts): WaiterCandidate {
  const eventMatch: EventMatchSpec = { clauses: [{ key: e.key }], once: opts.once ?? false, self: [] };
  const waiter: Wakeup = {
    id, sessionId: opts.sessionId, threadId: opts.threadId, kind: "event", status: "running", reason: "wait",
    logOffset: 0, logTail: "", eventCount: 0, createdAt: opts.createdAt ?? 100, updatedAt: 1, deadlineAt: 10_000_000,
    subjects: opts.subjects, eventMatch, eventBuffer: [],
  };
  const accepted = opts.accepted ?? true;
  return {
    waiter,
    session: { sessionId: opts.sessionId, orgId: ORG, ownerType: opts.owner.type, ownerId: opts.owner.id },
    digests: accepted ? [toDigest(e)] : [],
    accepted,
  };
}

/** The Scenario C stream waiter in `t-inc`, for one event. */
const tInc = (e: NormalizedEvent, over: Partial<CandidateOpts> = {}) =>
  candidate("w-inc", e, { owner: SRE, sessionId: "s-inc", threadId: "t-inc", subjects: [CHANNEL], ...over });

interface Fakes {
  deps: ClaimDeps;
  bindings: Map<string, ConversationBinding>;
  undeliverable: Set<string>;
  /** Subscription ids that a team rule covers. */
  covered: Set<string>;
  bindingLookups: Principal[];
}

function fakes(opts: { covered?: (owner: Principal) => boolean } = {}): Fakes {
  const bindings = new Map<string, ConversationBinding>();
  const undeliverable = new Set<string>();
  const bindingLookups: Principal[] = [];
  const covered = new Set<string>();
  const deps: ClaimDeps = {
    isDeliverable: async (_owner, target) => !undeliverable.has(target.threadId),
    mentionCovered: async (owner) => opts.covered?.(owner) ?? false,
    teamCovered: async (id) => covered.has(id),
  };
  return { deps, bindings, undeliverable, covered, bindingLookups };
}

function resolve(f: Fakes, args: Pick<ResolveClaimsArgs, "event" | "matched" | "candidates"> & { twin?: NormalizedEvent | null }) {
  return resolveClaims(f.deps, {
    orgId: ORG,
    twin: null,
    ...args,
    binding: async (owner) => {
      f.bindingLookups.push(owner);
      return f.bindings.get(`${owner.type}:${owner.id}`) ?? null;
    },
    // The dispatcher's test: a binding, a mention, or a direct message.
    conversational: (binding) => binding !== null || args.event.key === "slack.app_mention",
  });
}

const M = sub("M", SRE);
const P = sub("P", SRE);

describe("resolveClaims: Scenario C", () => {
  it("C1: a top-level channel message is claimed by t-inc, which appends its digest", async () => {
    const f = fakes();
    const message = slackEvent("slack.message", undefined, { payload: { channel: "C900", user: "U001", text: "status", ts: "2.0" } });
    const d = await resolve(f, { event: message, matched: [P], candidates: [tInc(message)] });
    expect(d.deliveries.get("P")).toEqual({ kind: "skip", reason: "claimed by thread t-inc" });
    expect(d.waiters.get("w-inc")).toBe("append");
  });

  it("C2: the mention redirects to t-inc, and neither half appends a digest", async () => {
    const { message, mention } = twins();
    const atMention = await resolve(fakes(), {
      event: mention, twin: message, matched: [M], candidates: withTwinCandidates([], [tInc(message)]),
    });
    expect(atMention.deliveries.get("M")).toEqual({ kind: "target", sessionId: "s-inc", threadId: "t-inc", reason: "claim_redirect", matchedWaiterId: "w-inc" });
    expect(atMention.waiters.get("w-inc")).toBe("suppress");

    const atMessage = await resolve(fakes({ covered: (o) => o.id === "sre" }), {
      event: message, twin: mention, matched: [P], candidates: [tInc(message)],
    });
    expect(atMessage.waiters.get("w-inc")).toBe("suppress");
    expect(atMessage.deliveries.get("P")).toEqual({ kind: "skip", reason: "claimed by thread t-inc" });
  });

  it("C3: a reply in a followed Slack thread lands through the binding, and t-inc appends no digest", async () => {
    const f = fakes();
    f.bindings.set("team:sre", { sessionId: "s-inc", threadId: "t-inc", via: "follow" });
    const reply = slackEvent("slack.message", "1.0", { payload: { channel: "C900", user: "U003", text: "on it", ts: "1.5", thread_ts: "1.0" } });
    const d = await resolve(f, { event: reply, matched: [P], candidates: [tInc(reply)] });
    expect(d.deliveries.get("P")).toEqual({ kind: "target", sessionId: "s-inc", threadId: "t-inc", reason: "conversation_follow", suppressedWaiterIds: ["w-inc"] });
    expect(d.waiters.get("w-inc")).toBe("suppress");
  });

  it("C3b: a reply the follow router delivers suppresses t-inc's digest, with no rule matched (one owner)", async () => {
    const f = fakes();
    f.deps.followRoute = async () => SRE;
    f.bindings.set("team:sre", { sessionId: "s-inc", threadId: "t-inc", via: "follow" });
    const reply = slackEvent("slack.message", "1.0", { payload: { channel: "C900", user: "U001", text: "on it", ts: "1.6", thread_ts: "1.0" } });
    const d = await resolve(f, { event: reply, matched: [], candidates: [tInc(reply)] });
    expect(d.waiters.get("w-inc")).toBe("suppress");
    expect(d.deliveries.size).toBe(0);
    // With rule P, P takes the binding stamp, and the dispatcher skips it (follow_routed).
    const withP = await resolve(f, { event: reply, matched: [P], candidates: [tInc(reply)] });
    expect(withP.waiters.get("w-inc")).toBe("suppress");
    expect(withP.deliveries.get("P")).toMatchObject({ kind: "target", reason: "conversation_follow", suppressedWaiterIds: ["w-inc"] });
  });

  it("C3b: a reply the router did not deliver lets the bound thread's waiter append, with no rule matched", async () => {
    const f = fakes();
    // The router dropped the reply before its binding existed, so ingest's route check says no.
    f.deps.followRoute = async () => null;
    f.bindings.set("team:sre", { sessionId: "s-inc", threadId: "t-inc", via: "follow" });
    const reply = slackEvent("slack.message", "1.0", { payload: { channel: "C900", user: "U001", text: "on it", ts: "1.65", thread_ts: "1.0" } });
    const d = await resolve(f, { event: reply, matched: [], candidates: [tInc(reply)] });
    expect(d.waiters.get("w-inc") ?? "append").toBe("append");
    expect(d.deliveries.size).toBe(0);
  });

  it("C3b: a failing follow route check lets the waiter append (INV-D6)", async () => {
    const f = fakes();
    f.deps.followRoute = async () => { throw new Error("db down"); };
    f.bindings.set("team:sre", { sessionId: "s-inc", threadId: "t-inc", via: "follow" });
    const reply = slackEvent("slack.message", "1.0", { payload: { channel: "C900", user: "U001", text: "on it", ts: "1.7", thread_ts: "1.0" } });
    const d = await resolve(f, { event: reply, matched: [], candidates: [tInc(reply)] });
    expect(d.waiters.get("w-inc") ?? "append").toBe("append");
    // Ingest records the failure like any other claim failure.
    expect(d.failedOwners).toBe(1);
  });

  it("C4: a mention that the sender gate refuses reaches t-inc as one digest", async () => {
    const { message, mention } = twins();
    // The team gate refused U002, so the mention matched no subscription.
    const atMention = await resolve(fakes(), { event: mention, twin: message, matched: [], candidates: withTwinCandidates([], [tInc(message)]) });
    expect(atMention.deliveries.size).toBe(0);
    expect(atMention.waiters.size).toBe(0);
    const atMessage = await resolve(fakes({ covered: () => false }), { event: message, twin: mention, matched: [P], candidates: [tInc(message)] });
    expect(atMessage.waiters.get("w-inc")).toBe("append");
    expect(atMessage.deliveries.get("P")).toEqual({ kind: "skip", reason: "claimed by thread t-inc" });
  });

  it("C5: a mention in X2 reaches t-s through its binding, and t-inc appends the channel message", async () => {
    const { message, mention } = twins("X2");
    const f = fakes({ covered: () => true });
    f.bindings.set("team:sre", { sessionId: "s-s", threadId: "t-s", via: "follow" });
    const atMention = await resolve(f, { event: mention, twin: message, matched: [M], candidates: withTwinCandidates([], [tInc(message)]) });
    expect(atMention.deliveries.get("M")).toEqual({ kind: "target", sessionId: "s-s", threadId: "t-s", reason: "conversation_follow" });
    expect(atMention.waiters.get("w-inc")).toBe("append");
    const atMessage = await resolve(f, { event: message, twin: mention, matched: [P], candidates: [tInc(message)] });
    expect(atMessage.deliveries.get("P")).toEqual({ kind: "target", sessionId: "s-s", threadId: "t-s", reason: "conversation_follow" });
    expect(atMessage.waiters.get("w-inc")).toBe("append");
  });

  it("C6: each team receives the mention once; platform's rule keeps its policy", async () => {
    const { message, mention } = twins("9.0");
    const f = fakes();
    const d = await resolve(f, {
      event: mention, twin: message, matched: [M, sub("M-platform", PLATFORM)], candidates: withTwinCandidates([], [tInc(message)]),
    });
    expect(d.deliveries.get("M")).toEqual({ kind: "target", sessionId: "s-inc", threadId: "t-inc", reason: "claim_redirect", matchedWaiterId: "w-inc" });
    expect(d.deliveries.has("M-platform")).toBe(false);
    // Platform has no candidate, so it needs no binding lookup.
    expect(f.bindingLookups).toEqual([SRE]);
  });

  const PR12 = "github:acme/api#12";
  const PR14 = "github:acme/api#14";
  const R1 = sub("R1", U001);
  const W = sub("W", U001, "workflow");
  const prEvent = (key: string, pr: string) => event({ key, subjects: ["github:acme", "github:acme/api", pr] });
  const tPr = (e: NormalizedEvent, id: string, subject: string) =>
    candidate(id, e, { owner: U001, sessionId: "s-pr", threadId: "t-pr", subjects: [subject] });

  it("C8 and C12: a review on #12 is claimed by t-pr; the workflow rule never yields", async () => {
    const review = prEvent("github.pull_request_review.submitted", PR12);
    const d = await resolve(fakes(), { event: review, matched: [R1, W], candidates: [tPr(review, "w-pr12", PR12)] });
    expect(d.deliveries.get("R1")).toEqual({ kind: "skip", reason: "claimed by thread t-pr" });
    expect(d.deliveries.has("W")).toBe(false);
    expect(d.waiters.get("w-pr12")).toBe("append");
  });

  it("C12: with only the workflow rule matched, nothing is stamped and t-pr appends", async () => {
    const review = prEvent("github.pull_request_review.submitted", PR12);
    const d = await resolve(fakes(), { event: review, matched: [W], candidates: [tPr(review, "w-pr12", PR12)] });
    expect(d.deliveries.size).toBe(0);
    expect(d.waiters.size).toBe(0);
  });

  it("C9: a comment on #14 lands in t-pr through the pull request binding, and the waiter appends no digest", async () => {
    const f = fakes();
    f.bindings.set("user:u-001", { sessionId: "s-pr", threadId: "t-pr", via: "pull_request" });
    const comment = prEvent("github.issue_comment.created", PR14);
    const d = await resolve(f, { event: comment, matched: [sub("R5", U001)], candidates: [tPr(comment, "w-pr14", PR14)] });
    expect(d.deliveries.get("R5")).toEqual({ kind: "target", sessionId: "s-pr", threadId: "t-pr", reason: "conversation_pull_request", suppressedWaiterIds: ["w-pr14"] });
    expect(d.waiters.get("w-pr14")).toBe("suppress");
  });

  it("C10: a check run on #14 is claimed by t-pr, which appends its digest", async () => {
    const check = prEvent("github.check_run.completed", PR14);
    const d = await resolve(fakes(), { event: check, matched: [R1], candidates: [tPr(check, "w-pr14", PR14)] });
    expect(d.deliveries.get("R1")).toEqual({ kind: "skip", reason: "claimed by thread t-pr" });
    expect(d.waiters.get("w-pr14")).toBe("append");
  });

  it("C11: an update on ENG-42 is claimed by t-tri, which appends its digest", async () => {
    const update = event({ key: "linear.issue.update", subjects: ["linear:team/ENG", "linear:ENG-42"] });
    const tri = candidate("w-tri", update, { owner: U001, sessionId: "s-tri", threadId: "t-tri", subjects: ["linear:ENG-42"] });
    const d = await resolve(fakes(), { event: update, matched: [sub("R3", U001)], candidates: [tri] });
    expect(d.deliveries.get("R3")).toEqual({ kind: "skip", reason: "claimed by thread t-tri" });
    expect(d.waiters.get("w-tri")).toBe("append");
  });
});

describe("resolveClaims: rules", () => {
  it("names the newest candidate in an ambient skip", async () => {
    const message = slackEvent("slack.message");
    const d = await resolve(fakes(), {
      event: message, matched: [P],
      candidates: [tInc(message, { createdAt: 300 }), candidate("w-old", message, { owner: SRE, sessionId: "s-old", threadId: "t-old", subjects: [CHANNEL], createdAt: 50 })],
    });
    expect(d.deliveries.get("P")).toEqual({ kind: "skip", reason: "claimed by thread t-inc" });
    expect([...d.waiters.values()]).toEqual(["append", "append"]);
  });

  it("breaks a createdAt tie on the waiter id, in any input order", async () => {
    const { message, mention } = twins();
    const a = (e: NormalizedEvent) => candidate("w-a", e, { owner: SRE, sessionId: "s-a", threadId: "t-a", subjects: [CHANNEL], createdAt: 500 });
    const b = (e: NormalizedEvent) => candidate("w-b", e, { owner: SRE, sessionId: "s-b", threadId: "t-b", subjects: [CHANNEL], createdAt: 500 });
    for (const order of [[a, b], [b, a]]) {
      const redirect = await resolve(fakes(), { event: mention, twin: message, matched: [M], candidates: withTwinCandidates([], order.map((c) => c(message))) });
      expect(redirect.deliveries.get("M")).toMatchObject({ kind: "target", threadId: "t-b", reason: "claim_redirect", matchedWaiterId: "w-b" });
      const skip = await resolve(fakes(), { event: message, matched: [P], candidates: order.map((c) => c(message)) });
      expect(skip.deliveries.get("P")).toEqual({ kind: "skip", reason: "claimed by thread t-b" });
    }
  });

  it("ignores a candidate whose thread cannot receive a delivery", async () => {
    const f = fakes();
    f.undeliverable.add("t-inc");
    const message = slackEvent("slack.message");
    const d = await resolve(f, { event: message, matched: [P], candidates: [tInc(message)] });
    expect(d.deliveries.size).toBe(0);
    expect(d.waiters.size).toBe(0);
    expect(f.bindingLookups).toEqual([]);
  });

  it("ignores a candidate that did not accept the event, and another owner's waiter", async () => {
    const message = slackEvent("slack.message");
    const d = await resolve(fakes(), {
      event: message, matched: [sub("P-u", U001)],
      candidates: [tInc(message), candidate("w-rej", message, { owner: U001, sessionId: "s-r", threadId: "t-r", subjects: [CHANNEL], accepted: false })],
    });
    expect(d.deliveries.size).toBe(0);
    expect(d.waiters.size).toBe(0);
  });

  it("leaves a legacy follow unstamped and lets every candidate append", async () => {
    const f = fakes();
    f.bindings.set("team:sre", { via: "legacy_follow", key: "slack:C900:1.0" });
    const reply = slackEvent("slack.message", "1.0");
    const d = await resolve(f, { event: reply, matched: [P], candidates: [tInc(reply)] });
    expect(d.deliveries.size).toBe(0);
    expect(d.waiters.get("w-inc")).toBe("append");
  });
});

describe("resolveClaims: Review Focus", () => {
  it("1: the mention and its message twin agree in either order", async () => {
    const { message, mention } = twins();
    const covered = { covered: (o: Principal) => o.id === "sre" };
    const atMention = () => resolve(fakes(covered), { event: mention, twin: message, matched: [M], candidates: withTwinCandidates([], [tInc(message)]) });
    const atMessage = () => resolve(fakes(covered), { event: message, twin: mention, matched: [], candidates: [tInc(message)] });
    const mentionFirst = [await atMention(), await atMessage()];
    const messageFirst = [await atMessage(), await atMention()].reverse();
    for (const [m, msg] of [mentionFirst, messageFirst]) {
      expect(m?.deliveries.get("M")).toEqual({ kind: "target", sessionId: "s-inc", threadId: "t-inc", reason: "claim_redirect", matchedWaiterId: "w-inc" });
      // The message matched no rule of sre, and the mention twin still suppresses the digest.
      expect(msg?.waiters.get("w-inc")).toBe("suppress");
      expect(msg?.deliveries.size).toBe(0);
    }
  });

  it("2: the Slack thread waiter is the redirect target, and the channel waiter appends", async () => {
    const { message, mention } = twins("X");
    const thread = (e: NormalizedEvent) => candidate("w-thread", e, { owner: SRE, sessionId: "s-thr", threadId: "t-thr", subjects: [`${CHANNEL}/X`], createdAt: 100 });
    // The channel waiter is newer, so only the subject decides.
    const channel = (e: NormalizedEvent) => tInc(e, { createdAt: 900 });
    const atMention = await resolve(fakes(), {
      event: mention, twin: message, matched: [M], candidates: withTwinCandidates([], [thread(message), channel(message)]),
    });
    expect(atMention.deliveries.get("M")).toEqual({ kind: "target", sessionId: "s-thr", threadId: "t-thr", reason: "claim_redirect", matchedWaiterId: "w-thread" });
    expect(atMention.waiters.get("w-thread")).toBe("suppress");
    expect(atMention.waiters.get("w-inc")).toBe("append");

    const atMessage = await resolve(fakes({ covered: () => true }), {
      event: message, twin: mention, matched: [], candidates: [thread(message), channel(message)],
    });
    expect(atMessage.waiters.get("w-thread")).toBe("suppress");
    expect(atMessage.waiters.get("w-inc")).toBe("append");
  });

  it("names a stream-mode redirect target on the stamp too, for digest recovery", async () => {
    const { message, mention } = twins();
    const stream = tInc(message);
    expect(stream.waiter.eventMatch?.once).not.toBe(true);
    const d = await resolve(fakes(), { event: mention, twin: message, matched: [M], candidates: withTwinCandidates([], [stream]) });
    expect(d.deliveries.get("M")).toMatchObject({ reason: "claim_redirect", matchedWaiterId: "w-inc" });
  });

  it("3: a once-mode redirect target is named on the stamp; an ambient skip names no waiter to end", async () => {
    const { message, mention } = twins();
    const once = tInc(message, { once: true });
    const d = await resolve(fakes(), { event: mention, twin: message, matched: [M], candidates: withTwinCandidates([], [once]) });
    // The stamp names the waiter, so the dispatcher can end it after the delivery.
    expect(d.deliveries.get("M")).toEqual({ kind: "target", sessionId: "s-inc", threadId: "t-inc", reason: "claim_redirect", matchedWaiterId: "w-inc" });
    const ambient = await resolve(fakes(), { event: message, matched: [P], candidates: [once] });
    expect(ambient.deliveries.get("P")).toEqual({ kind: "skip", reason: "claimed by thread t-inc" });
  });

  it("4: a throw for one owner leaves that owner unstamped and appending, and others resolve", async () => {
    const message = slackEvent("slack.message");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes();
    const d = await resolveClaims(f.deps, {
      orgId: ORG, event: message, twin: null,
      matched: [P, sub("P-u", U001)],
      candidates: [tInc(message), candidate("w-u", message, { owner: U001, sessionId: "s-u", threadId: "t-u", subjects: [CHANNEL] })],
      binding: async (owner) => {
        if (owner.id === "sre") throw new Error("db down");
        return null;
      },
      conversational: () => false,
    });
    expect(d.failedOwners).toBe(1);
    expect(d.deliveries.has("P")).toBe(false);
    expect(d.waiters.has("w-inc")).toBe(false);
    expect(d.deliveries.get("P-u")).toEqual({ kind: "skip", reason: "claimed by thread t-u" });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});

describe("resolveClaims: fix round 1", () => {
  it("both halves choose one target when a mention-only waiter competes with a message waiter", async () => {
    const { message, mention } = twins();
    // W1 waits for channel messages; W2 is newer and waits only for mentions.
    const w1 = (e: NormalizedEvent) => tInc(e, { createdAt: 100 });
    const w2 = (e: NormalizedEvent) => candidate("w-mention", e, { owner: SRE, sessionId: "s-m", threadId: "t-m", subjects: [CHANNEL], createdAt: 200 });
    const rejected = (c: WaiterCandidate): WaiterCandidate => ({ ...c, digests: [], accepted: false });
    const covered = { covered: () => true };
    // Mention ingest: W2 accepts the mention itself; W1 accepts the message twin.
    const atMention = () => resolve(fakes(covered), {
      event: mention, twin: message, matched: [M], candidates: withTwinCandidates([rejected(w1(mention)), w2(mention)], [w1(message), rejected(w2(message))]),
    });
    // Message ingest: W1 accepts the message; W2 accepts the mention twin.
    const atMessage = () => resolve(fakes(covered), {
      event: message, twin: mention, matched: [P], candidates: withTwinCandidates([w1(message), rejected(w2(message))], [rejected(w1(mention)), w2(mention)]),
    });
    for (const order of ["mention first", "message first"]) {
      let m;
      let msg;
      if (order === "mention first") {
        m = await atMention();
        msg = await atMessage();
      } else {
        msg = await atMessage();
        m = await atMention();
      }
      expect(m?.deliveries.get("M")).toMatchObject({ kind: "target", threadId: "t-m", reason: "claim_redirect" });
      expect(m?.waiters.get("w-mention")).toBe("suppress");
      // W1 is not the target, so it appends its message digest at the message ingest.
      expect(msg?.waiters.get("w-inc")).toBe("append");
      expect(msg?.waiters.get("w-mention")).toBe("suppress");
    }
  });

  it("a team-covered personal rule claims nothing, and its owner's waiter appends", async () => {
    const { message, mention } = twins();
    const f = fakes();
    f.covered.add("M-personal");
    const uWaiter = candidate("w-u", message, { owner: U001, sessionId: "s-u", threadId: "t-u", subjects: [CHANNEL] });
    const d = await resolve(f, { event: mention, twin: message, matched: [M, sub("M-personal", U001)], candidates: withTwinCandidates([], [tInc(message), uWaiter]) });
    expect(d.deliveries.has("M-personal")).toBe(false);
    expect(d.waiters.has("w-u")).toBe(false);
    expect(d.deliveries.get("M")).toMatchObject({ kind: "target", threadId: "t-inc" });
  });

  it("leaves a signal target unstamped (INV-D7)", async () => {
    const message = slackEvent("slack.message");
    const signal: ClaimSubscription = { id: "S", ownerType: "org", ownerId: ORG, target: { kind: "signal", signal: "incident" } };
    const d = await resolve(fakes(), { event: message, matched: [signal], candidates: [tInc(message)] });
    expect(d.deliveries.size).toBe(0);
    expect(d.waiters.size).toBe(0);
  });

  it("gives one turn when two rules of one owner redirect to one thread", async () => {
    const { message, mention } = twins();
    const d = await resolve(fakes(), { event: mention, twin: message, matched: [sub("M-b", SRE), sub("M-a", SRE)], candidates: withTwinCandidates([], [tInc(message)]) });
    expect(d.deliveries.get("M-a")).toEqual({ kind: "target", sessionId: "s-inc", threadId: "t-inc", reason: "claim_redirect", matchedWaiterId: "w-inc" });
    expect(d.deliveries.get("M-b")).toEqual({ kind: "skip", reason: "claimed by thread t-inc" });
  });
});

describe("withTwinCandidates", () => {
  it("adds a twin candidate without digests and keeps the event's own candidates", () => {
    const { message, mention } = twins();
    const own = candidate("w-own", mention, { owner: SRE, sessionId: "s-o", threadId: "t-o", subjects: [CHANNEL] });
    const merged = withTwinCandidates([own], [tInc(message), candidate("w-no", message, { owner: SRE, sessionId: "s-n", threadId: "t-n", subjects: [CHANNEL], accepted: false })]);
    expect(merged.map((c) => [c.waiter.id, c.accepted, c.digests.length])).toEqual([["w-own", true, 1], ["w-inc", true, 0]]);
  });
});

/**
 * The mention twin counts as covered only when an assistant rule of the
 * owner matches it and its sender gate admits the sender (Part C step 8).
 * A refused mention stays an ordinary channel message for the waiter.
 */
describe("mentionCoveredBy", () => {
  let tdb: TestPgDb;
  beforeEach(async () => {
    tdb = await freshTestPgDb();
    await tdb.appDb.insert(teams).values({ id: "sre", orgId: ORG, name: "SRE", createdAt: 1 });
    await tdb.appDb.insert(teamMembers).values({ teamId: "sre", userId: "u-001", role: "member" });
    await tdb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "u-001", role: "member" });
    await tdb.appDb.insert(userIdentityLinks).values({ id: "link-1", provider: "slack", externalId: "U001", userId: "u-001", createdAt: 1 });
  });

  const catalog = catalogForService([slackPlugin], "slack");
  const notCovered = async () => false;
  function rule(owner: Principal, over: Record<string, unknown> = {}) {
    return {
      enabled: true, orgId: ORG, ownerType: owner.type, ownerId: owner.id, createdBy: "u-001",
      target: { kind: "orchestrator" }, eventKeys: ["slack.app_mention"], filters: [], ...over,
    };
  }
  const mentionFrom = (user: string) => slackEvent("slack.app_mention", undefined, {
    payload: { type: "app_mention", channel: "C900", user, text: "<@U-BOT> status?", ts: "2.0" },
  });

  it("covers a team mention from a linked member", async () => {
    expect(await mentionCoveredBy(tdb.appDb, [rule(SRE)], SRE, mentionFrom("U001"), catalog, notCovered)).toBe(true);
  });

  it("does not cover a team mention from an unlinked sender (C4)", async () => {
    expect(await mentionCoveredBy(tdb.appDb, [rule(SRE)], SRE, mentionFrom("U002"), catalog, notCovered)).toBe(false);
  });

  it("covers an unlinked sender's mention under a personal rule, which has no sender gate", async () => {
    // A personal mention rule must name its user filter (mention-scope rule).
    const personal = rule(U001, { filters: [{ field: "user", op: "eq", value: "U002" }] });
    expect(await mentionCoveredBy(tdb.appDb, [personal], U001, mentionFrom("U002"), catalog, notCovered)).toBe(true);
  });

  it("does not cover a mention under a personal rule that a team rule covers", async () => {
    const personal = rule(U001, { filters: [{ field: "user", op: "eq", value: "U002" }] });
    expect(await mentionCoveredBy(tdb.appDb, [personal], U001, mentionFrom("U002"), catalog, async () => true)).toBe(false);
  });

  it("does not cover a mention under a disabled rule, another owner's rule, or a workflow rule", async () => {
    expect(await mentionCoveredBy(tdb.appDb, [rule(SRE, { enabled: false })], SRE, mentionFrom("U001"), catalog, notCovered)).toBe(false);
    expect(await mentionCoveredBy(tdb.appDb, [rule(SRE)], PLATFORM, mentionFrom("U001"), catalog, notCovered)).toBe(false);
    expect(await mentionCoveredBy(tdb.appDb, [rule(SRE, { target: { kind: "workflow", workflowId: "wf" } })], SRE, mentionFrom("U001"), catalog, notCovered)).toBe(false);
  });
});
