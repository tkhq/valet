import { describe, expect, it } from "vitest";
import { WebPresence, WEB_PRESENCE_TTL_MS } from "./web-presence.js";

describe("web presence", () => {
  it("expires at the TTL without a final idle report", () => {
    const presence = new WebPresence();
    expect(presence.isActive("u", 1)).toBe(false);
    presence.report("u", "a", true, 100);
    expect(presence.isActive("u", 100 + WEB_PRESENCE_TTL_MS - 1)).toBe(true);
    expect(presence.isActive("u", 100 + WEB_PRESENCE_TTL_MS)).toBe(false);
    presence.report("u", "a", true, 200);
    expect(presence.isActive("u", 200 + WEB_PRESENCE_TTL_MS - 1)).toBe(true);
  });

  it("counts any active tab and isolates users", () => {
    const presence = new WebPresence();
    presence.report("u", "a", true, 100);
    presence.report("u", "b", true, 100);
    presence.report("v", "a", true, 100);
    presence.report("u", "a", false, 101);
    expect(presence.isActive("u", 102)).toBe(true);
    presence.report("u", "b", false, 103);
    expect(presence.isActive("u", 104)).toBe(false);
    expect(presence.isActive("v", 104)).toBe(true);
  });
});
