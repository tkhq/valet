/**
 * Identity step pure logic (decision 11): reroll randomness, chip
 * composition, and the "Skip personality" submit path (name only, even
 * when the textarea has text). No DOM — these are extracted precisely so
 * they're testable without mounting the mutation (CLAUDE.md: pure
 * functions over exercising private/DOM internals).
 */
import { describe, expect, it } from "vitest";
import { appendTraitSentence, identitySubmitBody, pickRandomName } from "./identity-step";

describe("pickRandomName", () => {
  it("picks a name from the pool", () => {
    const pool = ["Atlas", "Wren"];
    const name = pickRandomName(pool, undefined, () => 0.99);
    expect(pool).toContain(name);
  });

  it("excludes the current name on reroll when another option exists", () => {
    const pool = ["Atlas", "Wren"];
    expect(pickRandomName(pool, "Atlas", () => 0)).toBe("Wren");
  });

  it("falls back to the full pool if excluding would empty it", () => {
    const pool = ["Atlas"];
    expect(pickRandomName(pool, "Atlas", () => 0)).toBe("Atlas");
  });
});

describe("appendTraitSentence", () => {
  it("starts a fresh sentence on empty text", () => {
    expect(appendTraitSentence("", "warm and direct")).toBe("You are warm and direct.");
  });

  it("composes multiple chip sentences in order", () => {
    const first = appendTraitSentence("", "warm and direct");
    const second = appendTraitSentence(first, "dry wit");
    expect(second).toBe("You are warm and direct. You are dry wit.");
  });

  it("appends after free-typed text too", () => {
    expect(appendTraitSentence("I like short replies.", "dry wit")).toBe(
      "I like short replies. You are dry wit.",
    );
  });
});

describe("identitySubmitBody", () => {
  it("includes trimmed personality when composing with it", () => {
    expect(identitySubmitBody(" Echo ", " You are warm. ", true)).toEqual({
      name: "Echo",
      personality: "You are warm.",
    });
  });

  it("Skip personality omits personality even when the field has text", () => {
    expect(identitySubmitBody("Echo", "You are warm.", false)).toEqual({ name: "Echo" });
  });

  it("omits personality when the field is blank", () => {
    expect(identitySubmitBody("Echo", "   ", true)).toEqual({ name: "Echo" });
  });
});
