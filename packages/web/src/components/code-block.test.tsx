// @vitest-environment jsdom
/**
 * CodeBlock: known languages get real Prism token spans (not just plain
 * text — the whole point of building this over a bare `<pre>`), unknown
 * languages fall back to plain monospace text instead of throwing, and the
 * copy button copies the exact source (trailing-newline-stripped, no
 * markup).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CodeBlock } from "./code-block";

describe("CodeBlock", () => {
  it("tokenizes a known language into Prism token spans", () => {
    const { container } = render(<CodeBlock code="const x = 1;" language="typescript" />);
    expect(container.querySelectorAll(".token").length).toBeGreaterThan(0);
  });

  it("falls back to plain text for an unregistered language", () => {
    render(<CodeBlock code="some cobol" language="cobol" />);
    expect(screen.getByText("some cobol")).toBeTruthy();
  });

  it("falls back to plain text when no language is given", () => {
    render(<CodeBlock code="plain text" />);
    expect(screen.getByText("plain text")).toBeTruthy();
  });

  it("copies the exact source, trailing newline stripped", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CodeBlock code={"echo hi\n"} language="bash" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("echo hi");
  });
});
