// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarkdownEditor, syncedScrollTop } from "./markdown-editor";

describe("syncedScrollTop", () => {
  it("maps the scroll ratio onto the destination's scrollable range", () => {
    // Source halfway (100/200 scrollable) → destination halfway (300/600).
    expect(
      syncedScrollTop(
        { scrollTop: 100, scrollHeight: 400, clientHeight: 200 },
        { scrollHeight: 800, clientHeight: 200 },
      ),
    ).toBe(300);
  });

  it("pins to the ends", () => {
    const dst = { scrollHeight: 800, clientHeight: 200 };
    expect(syncedScrollTop({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }, dst)).toBe(0);
    expect(syncedScrollTop({ scrollTop: 200, scrollHeight: 400, clientHeight: 200 }, dst)).toBe(600);
  });

  it("returns 0 when either pane has nothing to scroll", () => {
    expect(
      syncedScrollTop(
        { scrollTop: 0, scrollHeight: 100, clientHeight: 200 },
        { scrollHeight: 800, clientHeight: 200 },
      ),
    ).toBe(0);
    expect(
      syncedScrollTop(
        { scrollTop: 100, scrollHeight: 400, clientHeight: 200 },
        { scrollHeight: 100, clientHeight: 200 },
      ),
    ).toBe(0);
  });
});

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
