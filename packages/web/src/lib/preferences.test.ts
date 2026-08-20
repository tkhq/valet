// @vitest-environment jsdom
/**
 * The tool-card default preference is a per-browser policy read at mount
 * by every `ToolShell`. Three properties matter: absent key resolves to
 * `smart`, a set value round-trips, and an unknown stored value never
 * escapes as an error — a stale value from a prior schema falls back to
 * `smart` instead.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getToolCardDefault, setToolCardDefault } from "./preferences";

describe("preferences: tool-card default", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns 'smart' when the key is absent (C1)", () => {
    expect(getToolCardDefault()).toBe("smart");
  });

  it("round-trips every known value (C2)", () => {
    setToolCardDefault("always-collapsed");
    expect(getToolCardDefault()).toBe("always-collapsed");

    setToolCardDefault("always-expanded");
    expect(getToolCardDefault()).toBe("always-expanded");

    setToolCardDefault("smart");
    expect(getToolCardDefault()).toBe("smart");
  });

  it("resolves an unknown stored value to 'smart' without throwing (C3)", () => {
    localStorage.setItem("tool-card-default", "garbage");
    expect(() => getToolCardDefault()).not.toThrow();
    expect(getToolCardDefault()).toBe("smart");
  });

  it("persists under the documented key name", () => {
    setToolCardDefault("always-expanded");
    expect(localStorage.getItem("tool-card-default")).toBe("always-expanded");
  });
});
