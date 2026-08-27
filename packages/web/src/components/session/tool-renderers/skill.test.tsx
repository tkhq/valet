// @vitest-environment jsdom
/**
 * The `skill` renderer serves two paths that must stay in lockstep:
 * the model's `skill` tool call, and a user's slash-command invocation
 * (the dispatcher's `<skill name="...">…</skill>` expansion). These tests
 * pin the parser to the dispatcher's exact output shape and pin the
 * invocation card to the tool-call presentation (collapsed card, not a
 * markdown dump).
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { parseSkillBlock, SkillInvocationBlock, skillRenderer } from "./skill";
import { pickRenderer } from "./index";

// Mirror of engine `commands/dispatch.ts`: block, then optional "\n\n" + raw.
function dispatcherExpansion(name: string, content: string, raw = ""): string {
  const block = `<skill name="${name}">\n${content.trim()}\n</skill>`;
  return raw ? `${block}\n\n${raw}` : block;
}

describe("parseSkillBlock", () => {
  it("parses a bare block (no arguments)", () => {
    const text = dispatcherExpansion("review", "# Review\n\nDo the review.");
    expect(parseSkillBlock(text)).toEqual({
      name: "review",
      content: "# Review\n\nDo the review.",
      rest: "",
    });
  });

  it("parses trailing arguments after the blank line", () => {
    const text = dispatcherExpansion("review", "# Review", "src/ and be thorough");
    expect(parseSkillBlock(text)).toEqual({
      name: "review",
      content: "# Review",
      rest: "src/ and be thorough",
    });
  });

  it("keeps multi-line arguments intact", () => {
    const text = dispatcherExpansion("review", "body", "line one\nline two");
    expect(parseSkillBlock(text)?.rest).toBe("line one\nline two");
  });

  it("parses an empty skill body", () => {
    expect(parseSkillBlock(dispatcherExpansion("empty", ""))).toEqual({
      name: "empty",
      content: "",
      rest: "",
    });
  });

  it("returns null for plain text", () => {
    expect(parseSkillBlock("just a normal message")).toBeNull();
    expect(parseSkillBlock("")).toBeNull();
  });

  it("returns null when a skill block is quoted mid-prose", () => {
    const quoted = `Look at this:\n${dispatcherExpansion("review", "body")}`;
    expect(parseSkillBlock(quoted)).toBeNull();
  });

  it("returns null for an unclosed block", () => {
    expect(parseSkillBlock('<skill name="review">\nbody with no close')).toBeNull();
  });
});

describe("skill renderer registration", () => {
  it("claims the skill tool instead of the fallback", () => {
    expect(pickRenderer("skill", { name: "review" })).toBe(skillRenderer);
  });

  it("shows the skill name as the header target", () => {
    expect(skillRenderer.formatTarget({ name: "review" }, "skill")).toBe("review");
    expect(skillRenderer.formatTarget({}, "skill")).toBeUndefined();
  });

  it("summarizes the result line count when completed", () => {
    expect(
      skillRenderer.formatSummary?.({ name: "r" }, { text: "a\nb\nc" }, "completed", "skill"),
    ).toBe("3 lines");
    expect(
      skillRenderer.formatSummary?.({ name: "r" }, undefined, "running", "skill"),
    ).toBeUndefined();
  });
});

describe("SkillInvocationBlock", () => {
  const block = { name: "review", content: "# Review\n\nDo the review.", rest: "" };

  it("renders a collapsed card with the skill name, not the body", () => {
    render(<SkillInvocationBlock block={block} />);
    expect(screen.getByText("review")).toBeTruthy();
    // Completed cards start collapsed — the skill markdown stays hidden.
    expect(screen.queryByText("Do the review.")).toBeNull();
  });

  it("reveals the skill body on expand", () => {
    render(<SkillInvocationBlock block={block} />);
    fireEvent.click(screen.getByRole("button", { name: /review/ }));
    expect(screen.getByText("Do the review.")).toBeTruthy();
  });
});
