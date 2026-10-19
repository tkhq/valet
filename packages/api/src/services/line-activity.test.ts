// Spec 2026-10-16 presence hub, Part D steps 1.4, 1.7, and 4: the pure core
// of a line's Activity.
import { describe, expect, it } from "vitest";
import type { ReceiptSubscriptionDecision } from "../wire/types.js";
import {
  inLinePlaces, lineActivityCounts, mergeLineActivity, type LineDecisionInput, type LineDeliveryInput,
} from "./line-activity.js";

const DAY = 24 * 60 * 60 * 1000;
const REPO = { key: "github:acme/api", label: "acme/api" };
const OTHER_REPO = { key: "github:acme/web", label: "acme/web" };

function delivery(over: Partial<LineDeliveryInput> & { id: string }): LineDeliveryInput {
  return {
    eventId: `ev_${over.id}`, subscriptionId: "sub_1", status: "delivered", createdAt: 1_000, deliveredAt: null,
    lastError: null, destination: null, eventKey: "github.pull_request.opened", place: REPO, ...over,
  };
}

function decision(
  receiptId: string, outcome: ReceiptSubscriptionDecision["outcome"],
  over: Partial<Omit<LineDecisionInput, "decision">> & { failedFilters?: ReceiptSubscriptionDecision["failedFilters"] } = {},
): LineDecisionInput {
  const { failedFilters, ...rest } = over;
  return {
    receiptId, at: 2_000, eventId: null, eventKey: "github.pull_request.opened", place: REPO,
    decision: { id: "sub_1", ownerType: "user", ownerId: "u1", target: "assistant", outcome, ...(failedFilters ? { failedFilters } : {}) },
    ...rest,
  };
}

const MEMBER = { linePlaces: ["github:acme/api"], admin: false };

describe("mergeLineActivity", () => {
  it("makes acted entries with tookMs only when delivered", () => {
    const entries = mergeLineActivity([
      delivery({ id: "d_ok", createdAt: 1_000, deliveredAt: 1_450, thread: { sessionId: "s1", threadId: "t1" } }),
      delivery({ id: "d_pending", createdAt: 2_000, status: "pending" }),
      delivery({ id: "d_dead", createdAt: 3_000, status: "dead", lastError: "Pick another thread in Presence." }),
    ], [], MEMBER);
    expect(entries.map((e) => e.id)).toEqual(["d_dead", "d_pending", "d_ok"]);
    expect(entries[2]).toEqual({
      id: "d_ok", kind: "acted", at: 1_000, eventId: "ev_d_ok", eventKey: "github.pull_request.opened",
      place: "github:acme/api", placeLabel: "acme/api",
      outcome: { status: "delivered", thread: { sessionId: "s1", threadId: "t1" } }, tookMs: 450,
    });
    expect(entries[1]).not.toHaveProperty("tookMs");
    expect(entries[0]).toMatchObject({ outcome: { status: "dead", deadText: "Pick another thread in Presence." } });
    expect(entries[0]).not.toHaveProperty("tookMs");
  });

  it("leaves out a dead delivery that a later delivery settled", () => {
    const entries = mergeLineActivity([
      delivery({ id: "d_dead", eventId: "ev_1", status: "dead", createdAt: 1_000 }),
      delivery({ id: "d_redo", eventId: "ev_1", status: "delivered", createdAt: 2_000, deliveredAt: 2_100 }),
    ], [], MEMBER);
    expect(entries.map((e) => e.id)).toEqual(["d_redo"]);
  });

  it("names each skip reason", () => {
    const entries = mergeLineActivity([
      delivery({ id: "d_claim", status: "skipped", createdAt: 10, lastError: "Skipped, claimed by thread t9.", destination: { kind: "skip", reason: "claimed by thread t9" } }),
      delivery({ id: "d_off", status: "skipped", createdAt: 11, lastError: "This line is off. Turn it on to receive these events." }),
      delivery({ id: "d_team", status: "skipped", createdAt: 12, lastError: "The team already listens for this." }),
    ], [
      decision("r_repo", "filter_excluded", { at: 20, failedFilters: [{ field: "repo", op: "eq" }, { field: "channel", op: "eq" }] }),
      decision("r_chan", "filter_excluded", { at: 21, failedFilters: [{ field: "channel", op: "in" }] }),
      decision("r_branch", "filter_excluded", { at: 22, failedFilters: [{ field: "head_branch", op: "eq" }] }),
      decision("r_label", "filter_excluded", { at: 23, failedFilters: [{ field: "review_state", op: "eq" }] }),
      decision("r_none", "filter_excluded", { at: 24 }),
      decision("r_sender", "authorization_denied", { at: 25 }),
      decision("r_off", "disabled", { at: 26 }),
      decision("r_key", "key_mismatch", { at: 27 }),
      decision("r_match", "matched", { at: 28 }),
    ], MEMBER);
    const reasons = Object.fromEntries(entries.map((e) => [e.id, [e.kind, e.reason, e.reasonText]]));
    expect(reasons).toEqual({
      d_claim: ["skipped", "claimed", undefined],
      d_off: ["skipped", "off", undefined],
      d_team: ["skipped", "other", "The team already listens for this."],
      "receipt:r_repo": ["skipped", "filters", "the repository filter"],
      "receipt:r_chan": ["skipped", "filters", "the channel filter"],
      "receipt:r_branch": ["skipped", "filters", "the branch filter"],
      "receipt:r_label": ["skipped", "filters", "the review state filter"],
      "receipt:r_none": ["skipped", "filters", "its filters"],
      "receipt:r_sender": ["skipped", "sender", undefined],
      "receipt:r_off": ["skipped", "off", undefined],
      "receipt:r_key": ["skipped", "other", undefined],
    });
    // The claim's text names the claiming thread, so it stays off the wire.
    expect(JSON.stringify(entries)).not.toContain("t9");
    expect(entries[0]?.id).toBe("receipt:r_key");
  });

  // Review Focus 1: a skipped event outside the line's places shows only to an admin.
  it("shows a member skipped entries only in the line's places, and an admin all of them", () => {
    const deliveries = [
      delivery({ id: "d_in", status: "delivered", createdAt: 1, deliveredAt: 2 }),
      delivery({ id: "d_out_acted", status: "delivered", createdAt: 3, deliveredAt: 4, place: OTHER_REPO }),
      delivery({ id: "d_out_skip", status: "skipped", createdAt: 5, lastError: "The team already listens for this.", place: OTHER_REPO }),
    ];
    const decisions = [
      decision("r_in", "filter_excluded", { at: 10, place: { key: "github:acme/api#4", label: "acme/api#4" } }),
      decision("r_out", "filter_excluded", { at: 11, place: OTHER_REPO }),
      decision("r_unknown", "disabled", { at: 12, place: null }),
    ];
    const member = mergeLineActivity(deliveries, decisions, MEMBER).map((e) => e.id);
    expect(member).toEqual(["receipt:r_in", "d_out_acted", "d_in"]);
    const admin = mergeLineActivity(deliveries, decisions, { ...MEMBER, admin: true }).map((e) => e.id);
    expect(admin).toEqual(["receipt:r_unknown", "receipt:r_out", "receipt:r_in", "d_out_skip", "d_out_acted", "d_in"]);
  });

  it("treats a line with no place filter as naming its whole service", () => {
    const decisions = [
      decision("r_any", "filter_excluded", { at: 10, place: OTHER_REPO }),
      decision("r_unknown", "filter_excluded", { at: 11, place: null }),
      decision("r_slack", "filter_excluded", { at: 12, place: { key: "slack:T1/C1", label: "C1" }, eventKey: "slack.message" }),
    ];
    const ids = mergeLineActivity([], decisions, { linePlaces: ["github:*"], admin: false }).map((e) => e.id);
    expect(ids).toEqual(["receipt:r_unknown", "receipt:r_any"]);
  });
});

describe("inLinePlaces", () => {
  it("covers a place inside a named place, and a Slack workspace covers its channels", () => {
    expect(inLinePlaces(["github:acme/api"], "github.push", "github:acme/api#3")).toBe(true);
    expect(inLinePlaces(["github:acme/api"], "github.push", "github:acme/web")).toBe(false);
    expect(inLinePlaces(["github:acme/api"], "github.push", null)).toBe(false);
    expect(inLinePlaces(["slack:T1"], "slack.message", "slack:T1/C1")).toBe(true);
    expect(inLinePlaces(["slack:T1/C1"], "slack.message", "slack:T1/C2")).toBe(false);
  });
});

describe("lineActivityCounts", () => {
  it("counts a delivery 29 days ago and not one 31 days ago", () => {
    const now = Date.UTC(2026, 9, 18, 12);
    const { perDay, actedLast30Days } = lineActivityCounts([now - 29 * DAY, now - 31 * DAY, now - 30 * DAY, now, now - 1_000], now);
    expect(perDay).toHaveLength(30);
    expect(perDay[0]).toBe(1);
    expect(perDay[29]).toBe(2);
    expect(actedLast30Days).toBe(3);
  });

  it("counts by UTC day, oldest first", () => {
    const now = Date.UTC(2026, 9, 18, 0, 30);
    const yesterdayLate = Date.UTC(2026, 9, 17, 23, 59);
    const { perDay } = lineActivityCounts([yesterdayLate], now);
    expect(perDay[28]).toBe(1);
    expect(perDay[29]).toBe(0);
  });
});
