import { describe, expect, it } from "vitest";
import {
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
