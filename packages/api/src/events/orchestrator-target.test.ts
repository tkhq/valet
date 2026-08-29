import { describe, expect, it } from "vitest";
import type { SignalContent } from "@valet/engine";
import { EVENTS_THREAD_KEY, threadKeyForSignal } from "./orchestrator-target.js";

describe("threadKeyForSignal", () => {
  const base: SignalContent = { kind: "signal", signalType: "slack.app_mention", body: "hi" };

  it("binds a channel-origin signal to its Slack thread key", () => {
    const signal: SignalContent = { ...base, origin: { channelType: "slack", threadKey: "slack:C1:1.2" } };
    expect(threadKeyForSignal(signal)).toBe("slack:C1:1.2");
  });

  it("routes a non-channel signal to the shared events firehose", () => {
    const signal: SignalContent = { ...base, signalType: "github.issues.opened" };
    expect(threadKeyForSignal(signal)).toBe(EVENTS_THREAD_KEY);
  });

  it("two mentions in the same Slack thread share one assistant thread; a new root gets a new one", () => {
    const first: SignalContent = { ...base, origin: { channelType: "slack", threadKey: "slack:C1:100" } };
    const replyInThread: SignalContent = { ...base, origin: { channelType: "slack", threadKey: "slack:C1:100" } };
    const newRoot: SignalContent = { ...base, origin: { channelType: "slack", threadKey: "slack:C1:200" } };
    expect(threadKeyForSignal(first)).toBe(threadKeyForSignal(replyInThread));
    expect(threadKeyForSignal(first)).not.toBe(threadKeyForSignal(newRoot));
  });
});
