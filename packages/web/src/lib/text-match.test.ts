import { describe, expect, it } from "vitest";
import { matchesNeedle } from "./text-match";

describe("matchesNeedle", () => {
  it("matches everything on an empty or whitespace query", () => {
    expect(matchesNeedle("", ["anything"])).toBe(true);
    expect(matchesNeedle("   ", ["anything"])).toBe(true);
    expect(matchesNeedle("", [])).toBe(true);
  });

  it("matches case-insensitively, anywhere in any field", () => {
    expect(matchesNeedle("HUB", ["GitHub", "code host"])).toBe(true);
    expect(matchesNeedle("host", ["GitHub", "Code Host"])).toBe(true);
  });

  it("trims the query before matching", () => {
    expect(matchesNeedle("  hub  ", ["GitHub"])).toBe(true);
  });

  it("skips absent fields instead of throwing", () => {
    expect(matchesNeedle("x", [undefined, null, "fox"])).toBe(true);
    expect(matchesNeedle("x", [undefined, null])).toBe(false);
  });

  it("OR-matches whitespace terms and preserves quoted phrases", () => {
    expect(matchesNeedle("github slack", ["Slack"])).toBe(true);
    expect(matchesNeedle('missing "code host"', ["GitHub", "Code Host"])).toBe(true);
    expect(matchesNeedle('missing "code host"', ["GitHub", "Code and host"])).toBe(false);
  });

  it("reports no match honestly", () => {
    expect(matchesNeedle("slack", ["GitHub", "github"])).toBe(false);
  });
});
