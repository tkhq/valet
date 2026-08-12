// @vitest-environment jsdom
/**
 * Markdown: a fenced code block renders through CodeBlock (real Prism
 * tokens for a known language, language pulled from the fence's info
 * string), inline code and prose text are unaffected.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders prose text", () => {
    render(<Markdown>{"hello **world**"}</Markdown>);
    expect(screen.getByText("world")).toBeTruthy();
  });

  it("tokenizes a fenced code block via CodeBlock", () => {
    const { container } = render(<Markdown>{"```typescript\nconst x = 1;\n```"}</Markdown>);
    expect(container.querySelector(".code-block")).toBeTruthy();
    expect(container.querySelectorAll(".token").length).toBeGreaterThan(0);
  });

  it("leaves inline code as plain text, not a code block", () => {
    const { container } = render(<Markdown>{"use `npm install`"}</Markdown>);
    expect(container.querySelector(".code-block")).toBeNull();
    expect(screen.getByText("npm install")).toBeTruthy();
  });

  it("falls back to plain text for a fence with no recognized language", () => {
    render(<Markdown>{"```cobol\nSOME COBOL\n```"}</Markdown>);
    expect(screen.getByText("SOME COBOL")).toBeTruthy();
  });
});
