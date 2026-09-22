import { describe, expect, it } from "vitest";
import {
  buildCommitMessage,
  controlsFromMode,
  modeFromControls,
  opaqueCorrelationIds,
  patchOverrides,
  resolveGitSettings,
} from "./git-attribution.js";

describe("Git attribution settings", () => {
  it("round-trips all four atomic identity and signer modes", () => {
    for (const identity of ["user", "valet"] as const) for (const signed of [false, true]) {
      expect(controlsFromMode(modeFromControls(identity, signed))).toEqual({ identity, signed });
    }
  });

  it("resolves each inherited field independently and clears one override", () => {
    const resolved = resolveGitSettings({ coAuthoredBy: false }, { mode: "valet_unsigned", coAuthoredBy: true, correlationTrailers: true });
    expect(resolved.values).toEqual({ mode: "valet_unsigned", coAuthoredBy: false, correlationTrailers: true });
    expect(resolved.sources.mode.scope).toBe("organization");
    expect(patchOverrides({ mode: "valet_unsigned", coAuthoredBy: false }, { mode: null })).toEqual({ coAuthoredBy: false });
  });

  it("creates stable opaque versioned IDs and distinct concurrent queue IDs", () => {
    const one = opaqueCorrelationIds("key", "session-readable", "queue-1");
    const retry = opaqueCorrelationIds("key", "session-readable", "queue-1");
    const concurrent = opaqueCorrelationIds("key", "session-readable", "queue-2");
    expect(one).toEqual(retry);
    expect(one.session).toMatch(/^v1s_[A-Za-z0-9_-]+$/u);
    expect(one.queueItem).not.toBe(concurrent.queueItem);
    expect(JSON.stringify(one)).not.toContain("session-readable");
  });
});

describe("commit message enrichment", () => {
  it("preserves unrelated trailers and deduplicates managed trailers on amend", () => {
    const first = buildCommitMessage("Subject\n\nBody\n\nSigned-off-by: A <a@example.com>\n", {
      coAuthor: { name: "Valet", email: "valet@example.com" }, sessionId: "v1s_a", queueItemId: "v1q_a",
    });
    const amended = buildCommitMessage(first, {
      coAuthor: { name: "Valet", email: "valet@example.com" }, sessionId: "v1s_a", queueItemId: "v1q_a",
    });
    expect(amended).toBe(first);
    expect(amended.match(/Co-authored-by:/gu)).toHaveLength(1);
    expect(amended).toContain("Signed-off-by: A <a@example.com>");
  });

  it("does not rewrite trailer-like body text outside the final trailer block", () => {
    const result = buildCommitMessage("Subject\n\nValet-Session: example in body\nMore text", { sessionId: "v1s_real", queueItemId: "v1q_real" });
    expect(result).toContain("Valet-Session: example in body");
    expect(result.endsWith("Valet-Session: v1s_real\nValet-Queue-Item: v1q_real\n")).toBe(true);
  });

  it("emits no managed trailers when disabled", () => {
    expect(buildCommitMessage("Subject\n", {})).toBe("Subject\n");
  });
});
