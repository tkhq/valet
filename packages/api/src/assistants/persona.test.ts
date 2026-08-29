import { describe, expect, it } from "vitest";
import { PERSONALITY_INJECT_CAP, personaPrefixText } from "./persona.js";

describe("personaPrefixText", () => {
  it("no name means no prefix, personality or not", () => {
    expect(personaPrefixText(null, "Chipper.")).toBe("");
  });

  it("name alone, and name + personality", () => {
    expect(personaPrefixText("Ada", "")).toBe("You are Ada.\n\n");
    expect(personaPrefixText("Ada", "Terse.")).toBe("You are Ada. Terse.\n\n");
  });

  it("caps the personality", () => {
    const long = "x".repeat(PERSONALITY_INJECT_CAP + 100);
    const out = personaPrefixText("Ada", long);
    expect(out).toContain("x".repeat(PERSONALITY_INJECT_CAP));
    expect(out.length).toBe("You are Ada. ".length + PERSONALITY_INJECT_CAP + 2);
  });
});
