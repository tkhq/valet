import type { NormalizedEvent } from "@valet/engine";
import { describe, expect, it } from "vitest";
import { slackEventSubjects, slackNaturalSubject, slackSubjects } from "./subjects.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    key: "slack.message",
    dedupeKey: "d1",
    occurredAt: "2026-10-16T00:00:00.000Z",
    refs: {},
    summary: "message",
    payload: {},
    ...overrides,
  };
}

describe("slackEventSubjects", () => {
  it("a threaded reply carries workspace, channel, and thread subjects", () => {
    const r = slackEventSubjects(
      "message",
      { type: "message", channel: "C001", user: "U001", ts: "1712345699.000200", thread_ts: "1712345678.000100" },
      "T001",
    );
    expect(r.subjects).toEqual(["slack:T001", "slack:T001/C001", "slack:T001/C001/1712345678.000100"]);
    expect(r.bot).toBe(false);
  });

  it("a thread root carries the thread subject for its own ts", () => {
    const r = slackEventSubjects(
      "message",
      { type: "message", channel: "C001", user: "U001", ts: "1712345678.000100" },
      "T001",
    );
    expect(r.subjects).toEqual(["slack:T001", "slack:T001/C001", "slack:T001/C001/1712345678.000100"]);
  });

  it("bot_message sets bot: true via bot_id", () => {
    const r = slackEventSubjects(
      "bot_message",
      { type: "message", subtype: "bot_message", channel: "C001", bot_id: "B001", ts: "1712345678.000100" },
      "T001",
    );
    expect(r.bot).toBe(true);
  });

  it("the subtype bot_message alone sets bot: true", () => {
    const r = slackEventSubjects(
      "message",
      { type: "message", subtype: "bot_message", channel: "C001", ts: "1712345678.000100" },
      "T001",
    );
    expect(r.bot).toBe(true);
  });

  it("falls back to the envelope team id when the inner event has no team", () => {
    const r = slackEventSubjects("message", { type: "message", channel: "C001", ts: "1712345678.000100" }, "T001");
    expect(r.subjects[0]).toBe("slack:T001");
  });

  it("prefers the envelope team over the inner team of a Slack Connect reply (final review, item 8)", () => {
    const r = slackEventSubjects(
      "message",
      { type: "message", team: "TEXT", channel: "C001", ts: "1712345699.000200", thread_ts: "1712345678.000100" },
      "T001",
    );
    expect(r.subjects).toEqual(["slack:T001", "slack:T001/C001", "slack:T001/C001/1712345678.000100"]);
  });

  it("falls back to the inner event's team when the envelope has none", () => {
    const r = slackEventSubjects(
      "message",
      { type: "message", team: "T002", channel: "C001", ts: "1712345678.000100" },
      undefined,
    );
    expect(r.subjects[0]).toBe("slack:T002");
  });
});

describe("slackSubjects.fromUrl", () => {
  it("a message permalink parses p-digits to a dotted ts", () => {
    expect(slackSubjects.fromUrl("https://acme.slack.com/archives/C001/p1712345678000100")).toEqual({
      subject: "slack:?/C001/1712345678.000100",
      slackChannel: "C001",
    });
  });

  it("a permalink with ?thread_ts= uses the thread ts", () => {
    expect(
      slackSubjects.fromUrl("https://acme.slack.com/archives/C001/p1712345699000200?thread_ts=1712345678.000100"),
    ).toEqual({ subject: "slack:?/C001/1712345678.000100", slackChannel: "C001" });
  });

  it("a channel-only permalink returns the channel subject", () => {
    expect(slackSubjects.fromUrl("https://acme.slack.com/archives/C001")).toEqual({
      subject: "slack:?/C001",
      slackChannel: "C001",
    });
  });

  it("a non-Slack URL returns null", () => {
    expect(slackSubjects.fromUrl("https://example.com/x")).toBeNull();
  });
});

describe("slackSubjects label/url", () => {
  it('label("slack:T001/C001/1712345678.000100") is "#C001 thread"', () => {
    expect(slackSubjects.label("slack:T001/C001/1712345678.000100")).toBe("#C001 thread");
  });

  it("url() returns null", () => {
    expect(slackSubjects.url("slack:T001/C001/1712345678.000100")).toBeNull();
  });
});

describe("slackNaturalSubject", () => {
  it("returns the channel subject labeled with the channel name", () => {
    const e = event({
      subjects: ["slack:T001", "slack:T001/C001"],
      refs: { channel: "C001", channel_name: "incidents" },
    });
    expect(slackNaturalSubject(e)).toEqual({ subject: "slack:T001/C001", label: "#incidents" });
  });

  it("returns the channel id label when the channel name is unknown", () => {
    const e = event({
      subjects: ["slack:T001", "slack:T001/C001"],
      refs: { channel: "C001" },
    });
    expect(slackNaturalSubject(e)).toEqual({ subject: "slack:T001/C001", label: "C001" });
  });

  it("returns null for a team-only event with no channel", () => {
    const e = event({ key: "slack.team_join", subjects: ["slack:T001"], refs: {} });
    expect(slackNaturalSubject(e)).toBeNull();
  });

  it("returns null when the event has no subjects", () => {
    const e = event({ subjects: [], refs: {} });
    expect(slackNaturalSubject(e)).toBeNull();
  });
});
