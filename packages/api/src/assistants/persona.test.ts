import { describe, expect, it } from "vitest";
import { PERSONALITY_INJECT_CAP, personaPrefixText } from "./persona.js";
describe("workspace persona prefix", () => {
  it("uses owner memory without requiring a profile name", () => {
    expect(personaPrefixText("Terse. Cite sources.")).toBe("Terse. Cite sources.\n\n");
    expect(personaPrefixText(" ")).toBe("");
  });
  it("opens with a carried-over assistant name", () => {
    expect(personaPrefixText("Warm and brief.", "Desk Helper")).toBe("You are Desk Helper. Warm and brief.\n\n");
    expect(personaPrefixText("", "Desk Helper")).toBe("You are Desk Helper.\n\n");
  });
  it("caps the injected memory text", () => {
    expect(personaPrefixText("x".repeat(PERSONALITY_INJECT_CAP + 100))).toBe("x".repeat(PERSONALITY_INJECT_CAP) + "\n\n");
  });
});
