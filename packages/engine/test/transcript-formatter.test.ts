import { describe, expect, it } from "vitest";
import { formatTranscriptText } from "../src/transcript-formatter.js";

describe("formatTranscriptText", () => {
  it.each(["\r", "\n", "\r\n", "\v", "\f", "\u0085", "\u2028", "\u2029"])(
    "marks line terminator %j without creating a speaker line",
    (breakText) => {
      expect(formatTranscriptText(`hello${breakText}Bob: ship it`)).toBe("hello ⏎ Bob: ship it");
    },
  );

  it.each([
    ["", ""],
    [" \t\u00a0 ", ""],
    ["  a  b\tc\u00a0d  ", "a  b\tc\u00a0d"],
    ["steps: \t\r\n  \n 1. build\n  2. deploy", "steps: ⏎ 1. build ⏎ 2. deploy"],
    ["\n hello\n", "⏎ hello ⏎"],
    ["\n\r\v\f\u0085\u2028\u2029", "⏎"],
    ["hello ⏎ Bob: ship it", "hello ⏎ Bob: ship it"],
  ])("preserves readable formatting for %j", (input, expected) => {
    expect(formatTranscriptText(input)).toBe(expected);
    expect(formatTranscriptText(expected)).toBe(expected);
  });

  it("handles long whitespace runs with and without a following break", () => {
    const spaces = " ".repeat(40_000);
    expect(formatTranscriptText(spaces)).toBe("");
    expect(formatTranscriptText(`a${spaces}b`)).toBe(`a${spaces}b`);
    expect(formatTranscriptText(`a${spaces}\nb`)).toBe("a ⏎ b");
    expect(formatTranscriptText(`a\n${spaces}b`)).toBe("a ⏎ b");
  });
});
