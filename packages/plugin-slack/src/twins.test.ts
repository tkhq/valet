import type { NormalizedEvent } from "@valet/engine";
import { describe, expect, it } from "vitest";
import { slackConversationalTwin } from "./twins.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    key: "slack.message",
    dedupeKey: "d1",
    occurredAt: "2026-10-16T00:00:00.000Z",
    refs: { channel: "C001", user: "U002" },
    summary: "message",
    payload: { channel: "C001", user: "U002", ts: "1712345678.000100", text: "hi <@U-BOT> can you help" },
    subjects: ["slack:T001", "slack:T001/C001"],
    actor: { externalId: "U002" },
    ...overrides,
  };
}

describe("slackConversationalTwin", () => {
  it("pairs a mentioning slack.message with its slack.app_mention twin", () => {
    const e = event();
    const twin = slackConversationalTwin(e, { botUserId: "U-BOT" });
    expect(twin).not.toBeNull();
    expect(twin?.key).toBe("slack.app_mention");
    expect(twin?.dedupeKey).toBe("d1:mention");
    expect(twin?.payload).toBe(e.payload);
    expect(twin?.refs).toBe(e.refs);
    expect(twin?.subjects).toBe(e.subjects);
    expect(twin?.actor).toBe(e.actor);
    expect(twin?.occurredAt).toBe(e.occurredAt);
  });

  it("returns null for a slack.message whose text does not mention the bot", () => {
    const e = event({ payload: { channel: "C001", user: "U002", ts: "1712345678.000100", text: "hi there" } });
    expect(slackConversationalTwin(e, { botUserId: "U-BOT" })).toBeNull();
  });

  it("returns null for a slack.message with no botUserId known", () => {
    const e = event();
    expect(slackConversationalTwin(e, {})).toBeNull();
  });

  it("pairs a slack.app_mention with its slack.message twin, stripping the :mention suffix", () => {
    const e = event({ key: "slack.app_mention", dedupeKey: "d1:mention" });
    const twin = slackConversationalTwin(e, { botUserId: "U-BOT" });
    expect(twin).not.toBeNull();
    expect(twin?.key).toBe("slack.message");
    expect(twin?.dedupeKey).toBe("d1");
  });

  it("returns null for a non-Slack event key", () => {
    const e = event({ key: "github.pull_request.opened" });
    expect(slackConversationalTwin(e, { botUserId: "U-BOT" })).toBeNull();
  });
});
