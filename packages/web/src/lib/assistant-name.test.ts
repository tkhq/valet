import { describe, expect, it } from "vitest";
import { assistantLabel, orchestratorName } from "./assistant-name";

describe("assistant display names", () => {
  it.each([undefined, null, "", "   "])("uses the exact fallback for %s", (name) => {
    expect(orchestratorName(name)).toBe("Default Orchestrator");
  });

  it("uses the configured name, including on a default assistant", () => {
    expect(orchestratorName("  Sentinel  ")).toBe("Sentinel");
    expect(assistantLabel({ name: "Sentinel", isDefault: true })).toBe("Sentinel");
  });

  it("distinguishes unnamed defaults from unnamed non-default assistants", () => {
    expect(assistantLabel({ isDefault: true })).toBe("Default Orchestrator");
    expect(assistantLabel({ name: "  ", isDefault: true })).toBe("Default Orchestrator");
    expect(assistantLabel({ isDefault: false })).toBe("Untitled assistant");
  });
});
