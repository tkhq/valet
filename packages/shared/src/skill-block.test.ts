import { describe, expect, it } from "vitest";
import { buildSkillBlock, parseSkillBlock, sliceSkillBlock } from "./skill-block.js";

describe("buildSkillBlock ↔ sliceSkillBlock round trip", () => {
  it("recovers name, body, and args exactly", () => {
    const text = buildSkillBlock("review", "# Review\n\nDo the review.", "src/ and be thorough");
    expect(sliceSkillBlock(text, "review", "src/ and be thorough")).toEqual({
      name: "review",
      content: "# Review\n\nDo the review.",
      rest: "src/ and be thorough",
    });
  });

  it("recovers a bare block (no args)", () => {
    const text = buildSkillBlock("review", "body");
    expect(sliceSkillBlock(text, "review")).toEqual({ name: "review", content: "body", rest: "" });
  });

  it("recovers an empty body", () => {
    const text = buildSkillBlock("empty", "   ");
    expect(sliceSkillBlock(text, "empty")).toEqual({ name: "empty", content: "", rest: "" });
  });

  it("is immune to a literal </skill> line inside the body", () => {
    const body = 'Example:\n<skill name="x">\ninner\n</skill>\n\nMore instructions.';
    const text = buildSkillBlock("meta", body);
    expect(sliceSkillBlock(text, "meta")).toEqual({ name: "meta", content: body, rest: "" });
  });

  it("is immune to a literal </skill> line inside the args", () => {
    const args = "why does\n</skill>\n\nappear here";
    const text = buildSkillBlock("review", "body", args);
    expect(sliceSkillBlock(text, "review", args)).toEqual({
      name: "review",
      content: "body",
      rest: args,
    });
  });

  it("returns null when the text does not match the stamped name/args", () => {
    const text = buildSkillBlock("review", "body", "src/");
    expect(sliceSkillBlock(text, "other", "src/")).toBeNull();
    expect(sliceSkillBlock(text, "review", "different args")).toBeNull();
    expect(sliceSkillBlock("plain prose", "review", "")).toBeNull();
  });

  it("rejects overlap on degenerate short texts", () => {
    // suffix and prefix overlapping means the "body" would be negative-length.
    expect(sliceSkillBlock('<skill name="x">\n</skill>', "x", "")).toBeNull();
  });
});

describe("parseSkillBlock (legacy tier)", () => {
  it("round-trips builder output without args", () => {
    const text = buildSkillBlock("review", "# Review\n\nDo the review.");
    expect(parseSkillBlock(text)).toEqual({
      name: "review",
      content: "# Review\n\nDo the review.",
      rest: "",
    });
  });

  it("round-trips builder output with multi-line args", () => {
    const text = buildSkillBlock("review", "body", "line one\nline two");
    expect(parseSkillBlock(text)).toEqual({
      name: "review",
      content: "body",
      rest: "line one\nline two",
    });
  });

  it("parses an empty body", () => {
    expect(parseSkillBlock(buildSkillBlock("empty", ""))).toEqual({
      name: "empty",
      content: "",
      rest: "",
    });
  });

  it("returns null for plain text, quoted blocks, and unclosed blocks", () => {
    expect(parseSkillBlock("just a normal message")).toBeNull();
    expect(parseSkillBlock("")).toBeNull();
    expect(parseSkillBlock(`Look:\n${buildSkillBlock("review", "body")}`)).toBeNull();
    expect(parseSkillBlock('<skill name="review">\nno close')).toBeNull();
  });
});
