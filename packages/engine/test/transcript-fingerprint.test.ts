import { describe, it, expect } from "vitest";
import { entriesToAgentMessages } from "../src/thread.js";
import { fingerprintEntries, fingerprintMessages, piAiVersion } from "../src/transcript-fingerprint.js";
import type { SessionEntry } from "../src/types.js";

const modelHint = { api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5" };

const abortedEntries: SessionEntry[] = [
  {
    id: "e-u",
    sessionId: "s",
    threadId: "t",
    parentId: null,
    type: "message",
    role: "user",
    content: "do the work",
    createdAt: 1,
  },
  {
    id: "e-a",
    sessionId: "s",
    threadId: "t",
    parentId: "e-u",
    type: "message",
    role: "assistant",
    content: "starting",
    model: "claude-haiku-4-5",
    stopReason: "abort",
    createdAt: 2,
  },
];

describe("transcript fingerprint", () => {
  it("reads abort from entries and stop from the rebuilt messages", () => {
    const entriesFp = fingerprintEntries(abortedEntries);
    expect(entriesFp).toMatch(/a abort /);

    const rebuilt = entriesToAgentMessages(abortedEntries, modelHint);
    const messagesFp = fingerprintMessages(rebuilt);
    expect(messagesFp).toMatch(/a stop /);
    expect(messagesFp).not.toMatch(/a abort /);
  });

  it("reads the installed pi-ai version", () => {
    expect(piAiVersion()).toMatch(/^\d+\.\d+/);
  });
});
