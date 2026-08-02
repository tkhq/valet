// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarkdownEditor } from "./markdown-editor";

describe("MarkdownEditor", () => {
  it("renders the value in the textarea and a live preview", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} ariaLabel="Doc content" />);
    expect((screen.getByLabelText("Doc content") as HTMLTextAreaElement).value).toBe("# Hello");
    expect(screen.getByRole("heading", { name: "Hello" })).toBeTruthy();
  });

  it("propagates edits through onChange", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} ariaLabel="Doc content" />);
    fireEvent.change(screen.getByLabelText("Doc content"), { target: { value: "new text" } });
    expect(onChange).toHaveBeenCalledWith("new text");
  });

  it("shows an empty-preview hint for whitespace-only content", () => {
    render(<MarkdownEditor value="   " onChange={vi.fn()} ariaLabel="Doc content" />);
    expect(screen.getByText("Nothing to preview yet.")).toBeTruthy();
  });
});
