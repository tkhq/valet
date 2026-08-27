import { describe, it, expect } from "vitest";
import { entriesToAgentMessages } from "../src/thread.js";
import {
  boundFingerprint,
  fingerprintEntries,
  fingerprintMessages,
  piAiVersion,
} from "../src/transcript-fingerprint.js";
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

const fixtureLeak = ["do the work", "starting", "hi"] as const;

describe("transcript fingerprint", () => {
  it("reads abort from entries and stop from the rebuilt messages", () => {
    const entriesFp = fingerprintEntries(abortedEntries);
    expect(entriesFp).toMatch(/a abort /);
    for (const text of fixtureLeak) {
      expect(entriesFp).not.toContain(text);
    }

    const rebuilt = entriesToAgentMessages(abortedEntries, modelHint);
    const messagesFp = fingerprintMessages(rebuilt);
    expect(messagesFp).toMatch(/a stop /);
    expect(messagesFp).not.toMatch(/a abort /);
    for (const text of fixtureLeak) {
      expect(messagesFp).not.toContain(text);
    }
  });

  it("reads the installed pi-ai version at module load", () => {
    expect(piAiVersion).toMatch(/^\d+\.\d+/);
  });

  it("prefixes count= and keeps the last lines under the byte cap", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `u - - - - text-${i}`);
    const bounded = boundFingerprint(lines.join("\n"), { maxBytes: 4096, maxLines: 10 });
    expect(bounded.startsWith("count=80\n")).toBe(true);
    expect(bounded).toContain("text-79");
    expect(bounded).not.toContain("text-0");
    expect(bounded.slice("count=80\n".length).split("\n")).toHaveLength(10);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(4096);

    const longLine = "x".repeat(200);
    const bulky = boundFingerprint(Array.from({ length: 50 }, () => longLine).join("\n"), {
      maxBytes: 4096,
      maxLines: 50,
    });
    expect(bulky.startsWith("count=50\n")).toBe(true);
    expect(Buffer.byteLength(bulky, "utf8")).toBeLessThanOrEqual(4096);
  });
});
