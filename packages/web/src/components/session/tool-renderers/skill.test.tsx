// @vitest-environment jsdom
/**
 * The `skill` renderer serves two paths that must stay in lockstep: the
 * model's `skill` tool call, and a user's slash-command invocation. The
 * invocation card goes through the SAME ToolCallBlock as a real tool
 * call (see message-item.tsx), so these tests cover the shared renderer
 * plus the extraction tiers. Fixtures come from the real producer format
 * (`buildSkillBlock` in @valet/shared — the same builder the engine's
 * dispatcher calls), not a hand-written mirror.
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { buildSkillBlock } from "@valet/shared";
import { extractSkillInvocation, skillRenderer } from "./skill";
import { SkillInvocationBlock } from "../message-item";
import { pickRenderer } from "./index";

describe("extractSkillInvocation", () => {
  it("tier 1: exact slice from wire metadata, immune to </skill> in the body", () => {
    const body = 'Example:\n<skill name="x">\ninner\n</skill>\n\nMore instructions.';
    const text = buildSkillBlock("meta", body, "src/");
    expect(extractSkillInvocation(text, { name: "meta", args: "src/" })).toEqual({
      name: "meta",
      content: body,
      rest: "src/",
    });
  });

  it("tier 2: metadata with unwrapped text (host Thread.skill submission) — whole text is the body", () => {
    const rendered = "# Deploy\n\nRun the deploy checklist.";
    expect(extractSkillInvocation(rendered, { name: "deploy" })).toEqual({
      name: "deploy",
      content: rendered,
      rest: "",
    });
  });

  it("tier 3: legacy rows without metadata parse via the anchored regex", () => {
    const text = buildSkillBlock("review", "# Review", "src/ and be thorough");
    expect(extractSkillInvocation(text)).toEqual({
      name: "review",
      content: "# Review",
      rest: "src/ and be thorough",
    });
  });

  it("returns null for plain text and mid-prose quotes without metadata", () => {
    expect(extractSkillInvocation("just a normal message")).toBeNull();
    expect(extractSkillInvocation("")).toBeNull();
    expect(extractSkillInvocation(`Look:\n${buildSkillBlock("review", "body")}`)).toBeNull();
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

  it("suppresses the line count for an empty body (no '1 line' over '(no output)')", () => {
    expect(
      skillRenderer.formatSummary?.({ name: "r" }, { text: "" }, "completed", "skill"),
    ).toBeUndefined();
  });

  it("summarizes producer failures as 'failed', not a line count", () => {
    expect(
      skillRenderer.formatSummary?.(
        { name: "nope" },
        { text: '[skill_not_found] There is no skill named "nope". Call skill again with one of: review.' },
        "completed",
        "skill",
      ),
    ).toBe("failed");
  });
});

describe("skill renderer Body", () => {
  const Body = skillRenderer.Body;

  it("renders [skill_not_found] results danger-toned with a copy affordance", () => {
    const message = '[skill_not_found] There is no skill named "nope". Call skill again with one of: review.';
    render(<Body args={{ name: "nope" }} result={{ text: message }} status="completed" toolName="skill" />);
    const el = screen.getByText(message);
    expect(el.className).toContain("text-danger");
    expect(screen.getByRole("button", { name: "Copy error" })).toBeTruthy();
  });

  it("shows the placeholder args the model passed", () => {
    render(
      <Body
        args={{ name: "deploy", args: { env: "prod" } }}
        result={{ text: "# Deploy" }}
        status="completed"
        toolName="skill"
      />,
    );
    expect(screen.getByText("env")).toBeTruthy();
    expect(screen.getByText("prod")).toBeTruthy();
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
