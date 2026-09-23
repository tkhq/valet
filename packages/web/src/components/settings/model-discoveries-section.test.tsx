// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { registryHealth } from "./model-discoveries-section";

const provider = {
  providerId: "anthropic",
  modelCount: 4,
  checkedAt: 1_000,
  usingBundledFallback: false,
  lastError: null,
};

describe("registryHealth", () => {
  it("shows offline, failed, stale, and current states", () => {
    expect(registryHealth({ remoteEnabled: false, providers: [provider] }, 2_000)).toBe("offline");
    expect(registryHealth({
      remoteEnabled: true,
      providers: [{ ...provider, lastError: "network down" }],
    }, 2_000)).toBe("failed");
    expect(registryHealth({
      remoteEnabled: true,
      providers: [{ ...provider, checkedAt: null }],
    }, 2_000)).toBe("stale");
    expect(registryHealth({ remoteEnabled: true, providers: [provider] }, 2_000)).toBe("current");
  });
});
