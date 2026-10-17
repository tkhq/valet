/**
 * Every old Events, Automation, and channel URL redirects to its Presence URL
 * and keeps its search params (spec Part A step 4, INV-H1). One test per row
 * of the table, one per legacy Events `tab` value, and one for the thrown
 * redirect each old route's `beforeLoad` uses.
 */
import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import {
  LEGACY_EVENTS_TABS,
  PRESENCE_REDIRECTS,
  presenceRedirectFor,
  redirectToPresence,
  type LegacyRoute,
} from "./-presence-redirects";

function target(from: LegacyRoute, params: Record<string, string>, search: Record<string, unknown>) {
  return presenceRedirectFor(from, params, search);
}

describe("presence redirect table", () => {
  it("covers every replaced route", () => {
    const froms = new Set(PRESENCE_REDIRECTS.map((row) => row.from));
    expect([...froms].sort()).toEqual([
      "/channel",
      "/events",
      "/events/$eventId",
      "/workflows",
      "/workflows/$workflowId",
      "/workflows/runs/$runId",
    ]);
  });

  it("sends /events with no tab to Places and keeps the workspace", () => {
    expect(target("/events", {}, { workspace: "t1" })).toEqual({ to: "/presence", params: {}, search: { workspace: "t1" } });
  });

  it("sends the Channels tab and an unknown tab to Places", () => {
    expect(target("/events", {}, { tab: "channels" })).toEqual({ to: "/presence", params: {}, search: {} });
    expect(target("/events", {}, { tab: "nonsense", q: "deploy" })).toEqual({ to: "/presence", params: {}, search: { q: "deploy" } });
  });

  it("sends a Subscriptions review link to the listener page and keeps review", () => {
    expect(target("/events", {}, { tab: "subscriptions", review: "sub-1", workspace: "t1" })).toEqual({
      to: "/presence/listeners/$id",
      params: { id: "sub-1" },
      search: { review: "sub-1", workspace: "t1" },
    });
  });

  it("sends the Subscriptions tab without a review to Places", () => {
    expect(target("/events", {}, { tab: "subscriptions" })).toEqual({ to: "/presence", params: {}, search: {} });
  });

  describe("legacy Log tab values open Activity", () => {
    const expected: Record<(typeof LEGACY_EVENTS_TABS)[number], Record<string, unknown>> = {
      log: { q: "deploy" },
      activity: { q: "deploy" },
      logs: { q: "deploy" },
      problems: { status: "problems", q: "deploy" },
      receipts: { status: "receipts", q: "deploy" },
    };
    it.each(LEGACY_EVENTS_TABS)("tab=%s", (tab) => {
      expect(target("/events", {}, { tab, q: "deploy" })).toEqual({ to: "/presence/activity", params: {}, search: expected[tab] });
    });
  });

  it("maps tab=receipts&status=problems as the Events page did: the tab wins", () => {
    expect(target("/events", {}, { tab: "receipts", status: "problems" })).toEqual({
      to: "/presence/activity",
      params: {},
      search: { status: "receipts" },
    });
  });

  it("keeps a valid Log status, drops an invalid one, and reads the old problemsQ search", () => {
    expect(target("/events", {}, { tab: "log", status: "problems" }).search).toEqual({ status: "problems" });
    expect(target("/events", {}, { tab: "log", status: "all" }).search).toEqual({});
    expect(target("/events", {}, { tab: "log", problemsQ: "timeout" }).search).toEqual({ q: "timeout" });
    expect(target("/events", {}, { tab: "log", q: "a", problemsQ: "b" }).search).toEqual({ q: "a" });
  });

  it("sends one event to its Presence URL", () => {
    expect(target("/events/$eventId", { eventId: "ev-1" }, {})).toEqual({
      to: "/presence/events/$eventId",
      params: { eventId: "ev-1" },
      search: {},
    });
  });

  it("sends the workflow list to the Workflows tab and keeps its params", () => {
    expect(target("/workflows", {}, { workspace: "t1", run: "r1", gate: "g1" })).toEqual({
      to: "/presence/workflows",
      params: {},
      search: { workspace: "t1", run: "r1", gate: "g1" },
    });
  });

  it.each(["scheduled", "triggers"])("sends /workflows?tab=%s to Routines and keeps review", (tab) => {
    expect(target("/workflows", {}, { tab, review: "sch-1" })).toEqual({
      to: "/presence/routines",
      params: {},
      search: { review: "sch-1" },
    });
  });

  it("sends /workflows?tab=runs to the Runs tab", () => {
    expect(target("/workflows", {}, { tab: "runs" })).toEqual({ to: "/presence/runs", params: {}, search: {} });
  });

  it("sends one workflow to its Presence URL and keeps newTrigger", () => {
    expect(target("/workflows/$workflowId", { workflowId: "wf-1" }, { newTrigger: "event" })).toEqual({
      to: "/presence/workflows/$workflowId",
      params: { workflowId: "wf-1" },
      search: { newTrigger: "event" },
    });
  });

  it("sends one run to its Presence URL and keeps gate, view, and conversation", () => {
    expect(target("/workflows/runs/$runId", { runId: "run-1" }, { gate: "n1", view: "details", conversation: "c1" })).toEqual({
      to: "/presence/runs/$runId",
      params: { runId: "run-1" },
      search: { gate: "n1", view: "details", conversation: "c1" },
    });
  });

  it("sends /channel?key= to the place page", () => {
    expect(target("/channel", {}, { key: "slack:C123", workspace: "t1" })).toEqual({
      to: "/presence/places/$subject",
      params: { subject: "slack:C123" },
      search: { workspace: "t1" },
    });
  });

  it("sends /channel without a key to Places", () => {
    expect(target("/channel", {}, {})).toEqual({ to: "/presence", params: {}, search: {} });
    expect(target("/channel", {}, { key: "" })).toEqual({ to: "/presence", params: {}, search: {} });
  });

  it("reads a tab that is not text as no tab", () => {
    expect(target("/events", {}, { tab: 7 })).toEqual({ to: "/presence", params: {}, search: {} });
  });

  it("reads a search that is not an object as empty", () => {
    expect(presenceRedirectFor("/workflows", {}, "tab=scheduled")).toEqual({ to: "/presence/workflows", params: {}, search: {} });
  });

  it("matches every row with at least one test above", () => {
    // Walks the table: each row resolves for a search built to select it.
    for (const row of PRESENCE_REDIRECTS) {
      const resolved = presenceRedirectFor(row.from, row.example.params, row.example.search);
      expect(resolved.to, `${row.from} (${row.when})`).toBe(row.to);
    }
  });
});

describe("redirectToPresence", () => {
  it("throws a replace redirect built from the table", () => {
    let thrown: unknown;
    try {
      redirectToPresence("/channel")({ params: {}, location: { search: { key: "slack:C1" } } });
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    if (!isRedirect(thrown)) return;
    expect(thrown.options).toMatchObject({
      to: "/presence/places/$subject",
      params: { subject: "slack:C1" },
      search: {},
      replace: true,
    });
  });
});
